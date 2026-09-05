/**
 * AI agent worker entry — leader-gated cycle loop.
 *
 * Cycle shape (the scale-critical design):
 *   Phase 1 — per SYMBOL, once: CoinGlass full series + Deribit DVOL into a
 *             shared cache (global mode: house CoinGlass key; BYOK legacy
 *             still supported). 1 or 1,000 agents trading BTC cost one pull.
 *   Phase 2 — per AGENT, concurrency-limited: LLM decisions + execution via
 *             executeAgentMonitoring. Failures isolate per agent.
 *             HL info reads coalesce via HlCycleCache (one wallet bundle /
 *             open-orders list per trading address per cycle).
 *
 * Multi-replica safe via the existing `try_claim_leadership` RPC.
 * HL weight: set HL_WEIGHT_PER_MINUTE on Railway (prod ~1100 on dedicated
 * egress). Keep Phase-1 + HlCycleCache + HlWeightBucket either way.
 */
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { config } from './config.js';
import { buildSymbolCache } from './data/marketCache.js';
import { maybeRefreshStickyNarratives } from './data/stickyNarratives.js';
import { maybeRefreshStickySymbolCatalysts } from './data/stickySymbolCatalysts.js';
import { getSupabase } from './lib/supabase.js';
import {
  beginHlCycleCache,
  endHlCycleCache,
} from './hl/adapter.js';
import { executeAgentMonitoring, type OpeningDecisionCache } from './monitor.js';
import {
  emptySignals,
  maybeAlertDegraded,
  mergeCycleHealth,
  persistAgentHealth,
} from './lib/agentHealth.js';
import { getOpenPositions, logDecision } from './stores.js';
import {
  backfillSignalOutcomes,
  resetSignalSnapshotCycle,
} from './lib/signalSnapshots.js';
import type { AgentRow } from './types.js';
import type { CoinglassMarketData } from './data/coinglass.js';

const LEADER_TASK = 'ai_agent_worker';
const HOLDER_ID = `ai-agent-${randomUUID().slice(0, 8)}`;

async function claimLeadership(): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('try_claim_leadership', {
    p_task: LEADER_TASK,
    p_holder_id: HOLDER_ID,
    p_ttl_seconds: config.cycleMinutes * 60 + 120,
  });
  if (error) {
    console.error('[leader] claim failed:', error.message);
    return false;
  }
  return data === true;
}

/**
 * Release our lease on shutdown so the replacement container can claim
 * immediately. Railway SIGTERMs the old container on every redeploy; without
 * this, the lease TTL (cycle + 2min) would stall the new container for up to
 * an hour. Scoped to our holder_id — never steals a live peer's lease.
 */
async function releaseLeadership(): Promise<void> {
  try {
    await getSupabase()
      .from('worker_leader')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('task_name', LEADER_TASK)
      .eq('holder_id', HOLDER_ID);
    console.log('[leader] lease released');
  } catch (err) {
    console.error('[leader] release failed:', err);
  }
}

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received — releasing leadership and exiting`);
    void releaseLeadership().finally(() => process.exit(0));
  });
}

async function loadActiveAgents(): Promise<AgentRow[]> {
  const { data, error } = await getSupabase()
    .from('ai_agents')
    .select('*')
    .eq('status', 'active')
    .eq('trading_env', config.hlEnv === 'testnet' ? 'demo' : 'mainnet');
  if (error) throw new Error(`loadActiveAgents: ${error.message}`);
  return (data ?? []) as AgentRow[];
}

/**
 * Paused/stopped agents never enter Phase 2 (no LLM / HL). Still write a
 * skip row each cycle so Recent decisions don't look like a mysterious gap.
 */
async function logInactiveAgentSkips(): Promise<void> {
  const { data, error } = await getSupabase()
    .from('ai_agents')
    .select('id, status, config')
    .in('status', ['paused', 'stopped'])
    .eq('trading_env', config.hlEnv === 'testnet' ? 'demo' : 'mainnet');
  if (error) {
    console.warn(`[cycle] inactive skip query failed: ${error.message}`);
    return;
  }
  const agents = (data ?? []) as Pick<AgentRow, 'id' | 'status' | 'config'>[];
  if (!agents.length) return;

  await Promise.all(
    agents.map((agent) => {
      const stopped = agent.status === 'stopped';
      return logDecision({
        agentId: agent.id,
        runId: null,
        symbol: agent.config?.symbols?.[0] ?? null,
        type: stopped ? 'skipped_stopped' : 'skipped_paused',
        decision: {
          reason: stopped
            ? 'Agent was stopped'
            : 'Agent was paused',
          status: agent.status,
        },
      });
    }),
  );
  console.log(`[cycle] logged ${agents.length} paused/stopped skip(s)`);
}

/** Phase 2 — full monitor pipeline for one agent, with audit row. */
async function runAgentCycle(
  agent: AgentRow,
  marketDataBySymbol: Map<string, CoinglassMarketData>,
  validCoinglassKeys: Set<string>,
  openingCache: OpeningDecisionCache,
  opts?: { sharedWalletClaimedSymbols?: Set<string> },
): Promise<void> {
  const supabase = getSupabase();
  const { data: run } = await supabase
    .from('ai_agent_runs')
    .insert({ agent_id: agent.id, status: 'running' })
    .select('id')
    .single();
  const runId = (run?.id as string | undefined) ?? null;
  let healthSignals = emptySignals(agent.config.symbols?.length ?? 0);
  try {
    const result = await executeAgentMonitoring({
      agent,
      runId,
      marketDataBySymbol,
      validCoinglassKeys,
      openingCache,
      sharedWalletClaimedSymbols: opts?.sharedWalletClaimedSymbols,
    });
    healthSignals = result.healthSignals;
    await supabase
      .from('ai_agent_runs')
      .update({
        status: 'ok',
        finished_at: new Date().toISOString(),
        equity_snapshot: result.equityUsd,
      })
      .eq('id', runId ?? '');
    console.log(
      `[cycle] agent ${agent.id} ok (mode=${agent.mode}, dry_run=${agent.dry_run}, symbols=${result.symbolsProcessed}, actions=${result.actionsExecuted})`,
    );
  } catch (err) {
    // Fatal for this agent this cycle only — never flips status to stopped.
    healthSignals = {
      ...emptySignals(agent.config.symbols?.length ?? 0),
      runFatal: true,
    };
    await supabase
      .from('ai_agent_runs')
      .update({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId ?? '');
    throw err;
  } finally {
    // Health is additive fallback signaling only — never mutates `status`.
    try {
      const { health, becameDegraded, becameRecovered } = mergeCycleHealth(
        agent.health,
        healthSignals,
      );
      const withAlert = await maybeAlertDegraded({
        privyUserId: agent.privy_user_id,
        agentId: agent.id,
        agentName: agent.name || 'AI agent',
        health,
        becameDegraded,
        becameRecovered,
      });
      await persistAgentHealth(agent.id, withAlert);
      agent.health = withAlert;
      if (withAlert.degraded) {
        console.warn(
          `[health] agent ${agent.id} degraded reasons=${withAlert.reasons.join(',')}` +
            ` streaks=md:${withAlert.marketDataBadStreak}/llm:${withAlert.llmErrorStreak}/exit:${withAlert.exitFailStreak}`,
        );
      }
    } catch (healthErr) {
      console.warn(`[health] update skipped for ${agent.id}:`, healthErr);
    }
    await supabase
      .from('ai_agents')
      .update({ last_run_at: new Date().toISOString() })
      .eq('id', agent.id);
  }
}

/** Signals the main loop to retry soon rather than sleep a full cycle. */
class NotLeaderError extends Error {}

async function cycle(): Promise<void> {
  const isLeader = await claimLeadership();
  if (!isLeader) {
    // A previous container's lease can outlive it by up to a full cycle after
    // a redeploy. Retry on a short interval so a replacement container takes
    // over within minutes instead of stalling until the next hour.
    throw new NotLeaderError();
  }
  const agents = await loadActiveAgents();
  console.log(`[cycle] leader ${HOLDER_ID}: ${agents.length} active agent(s)`);
  await logInactiveAgentSkips();
  if (!agents.length) return;

  const { marketData, validKeys, keysLabel } = await buildSymbolCache(agents);
  console.log(`[cycle] phase 1 done: ${marketData.size} series (symbol×interval), ${keysLabel}`);

  // Signal calibration data: fill forward returns for earlier snapshots from
  // the bars we just fetched, then open a fresh dedupe window for this
  // cycle's writes (monitor.ts records one row per symbol×interval×horizon).
  resetSignalSnapshotCycle();
  const outcomes = await backfillSignalOutcomes(marketData).catch((err) => {
    console.warn('[signals] backfill hook error:', err);
    return { scanned: 0, updated: 0 };
  });
  if (outcomes.scanned > 0) {
    console.log(`[signals] outcomes backfilled ${outcomes.updated}/${outcomes.scanned}`);
  }

  // Sticky narratives: 2×/day off-hour slots (02:30 Asia, 15:30 US). No-op
  // outside the claim window; agents only read the cached board.
  const stickyResult = await maybeRefreshStickyNarratives().catch((err) => {
    console.warn('[sticky-narratives] hook error:', err);
    return 'failed' as const;
  });
  if (stickyResult === 'refreshed') {
    console.log('[cycle] sticky narratives board refreshed');
  }

  // Per-symbol ticker catalysts (Clarity Act, partnerships, unlocks, …).
  // Same Asia/US slots get a higher refresh budget; otherwise a small
  // bootstrap cap so new names (e.g. CRCL) aren't blind after deploy.
  // NOTE: marketData keys are `symbol|interval` since the 30m-bars change —
  // pass PLAIN agent symbols or catalysts get written to `SNDK|1H`-style
  // cache keys that no agent ever reads (live regression 2026-08-06).
  const activeSymbols = [
    ...new Set(
      agents.flatMap((a) => (a.config.symbols ?? []).map((s) => s.toUpperCase())),
    ),
  ];
  const symStats = await maybeRefreshStickySymbolCatalysts(activeSymbols).catch((err) => {
    console.warn('[sticky-symbol] hook error:', err);
    return { refreshed: 0, skipped: 0, failed: 0 };
  });
  if (symStats.refreshed > 0) {
    console.log(
      `[cycle] sticky symbol catalysts refreshed=${symStats.refreshed} failed=${symStats.failed}`,
    );
  }

  // Cross-agent opening-decision dedupe: agents sharing (symbol, model) reuse
  // one LLM call per cycle. Fresh map every cycle — decisions never go stale.
  const openingCache: OpeningDecisionCache = new Map();

  // P0: coalesce HL info reads for the whole cycle (cleared in finally).
  beginHlCycleCache();
  try {
    // Shared-wallet (copilot) agents on the same master must not open in parallel —
    // each would size against stale free margin and burn LLM calls on doomed orders.
    // Dedicated agents keep their own clearinghouse, so they can fan out safely.
    // Within a shared-wallet group: sequential + symbol claims (first writer wins).
    const dedicated = agents.filter((a) => a.mode === 'dedicated');
    const copilotsByMaster = new Map<string, AgentRow[]>();
    for (const a of agents) {
      if (a.mode === 'dedicated') continue;
      const key = a.hl_master_address.toLowerCase();
      const list = copilotsByMaster.get(key) ?? [];
      list.push(a);
      copilotsByMaster.set(key, list);
    }

    const limit = pLimit(config.agentConcurrency);
    const jobs: Promise<unknown>[] = [];

    for (const a of dedicated) {
      jobs.push(limit(() => runAgentCycle(a, marketData, validKeys, openingCache)));
    }

    for (const group of copilotsByMaster.values()) {
      jobs.push(
        limit(async () => {
          // Seed claims with symbols already open on any agent in this wallet
          // so peers skip before LLM (existing owner / first-writer wins).
          const claimedSymbols = new Set<string>();
          await Promise.all(
            group.map(async (a) => {
              const opens = await getOpenPositions(a.id).catch(() => []);
              for (const row of opens) claimedSymbols.add(row.symbol.toUpperCase());
            }),
          );
          for (const a of group) {
            try {
              await runAgentCycle(a, marketData, validKeys, openingCache, {
                sharedWalletClaimedSymbols: claimedSymbols,
              });
            } catch (err) {
              console.error(`[cycle] copilot agent ${a.id} failed:`, err);
            }
          }
        }),
      );
    }

    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.error(`[cycle] ${failed}/${jobs.length} agent job(s) failed`);
  } finally {
    endHlCycleCache();
  }
}

const NOT_LEADER_RETRY_MS = 2 * 60_000;

/** ms until the next round cycle boundary (e.g. :00 for 60m cycles). */
function msUntilNextBoundary(): number {
  const cycleMs = config.cycleMinutes * 60_000;
  const rem = Date.now() % cycleMs;
  // Exactly on a boundary → wait a full cycle (caller already ran, or just booted).
  return rem === 0 ? cycleMs : cycleMs - rem;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log(`[worker] ai-agent-worker starting (env=${config.hlEnv}, cycle=${config.cycleMinutes}m, holder=${HOLDER_ID})`);
  // Always wait for the next clock boundary BEFORE running — including first
  // boot. An immediate cycle on deploy would fire mid-hour (e.g. 11:30) and
  // break the user-facing "hourly on the hour" contract. Redeploys / failover
  // may skip at most one cycle; they must never invent an off-schedule run.
  for (;;) {
    try {
      const waitMs = msUntilNextBoundary();
      console.log(`[cycle] next boundary in ${Math.round(waitMs / 1000)}s`);
      await sleep(Math.max(1_000, waitMs));
      await cycle();
    } catch (err) {
      if (err instanceof NotLeaderError) {
        // Stale lease from a replaced container — poll until it expires, then
        // loop back and wait for the next boundary (do not cycle mid-hour).
        console.log(`[cycle] not leader, retrying leadership in ${NOT_LEADER_RETRY_MS / 1000}s`);
        await sleep(NOT_LEADER_RETRY_MS);
      } else {
        console.error('[cycle] fatal cycle error:', err);
        // Still align to the next boundary rather than hammering.
      }
    }
  }
}

void main();
