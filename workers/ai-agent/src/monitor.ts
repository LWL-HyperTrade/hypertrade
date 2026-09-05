/**
 * executeAgentMonitoring — per-agent decision cycle.
 *
 * Parameterized refactor of the old cron-monitor.ts (no Aster, no BTC/ETH
 * hardcode, no Redis, no Pinata). The brain wiring is intentionally pragmatic:
 * the prompt/flag pipeline is preserved, but trade logic is provisional and
 * will be reviewed separately (per product decision) — the INTEGRATION
 * contract (guards, budget caps, dry-run, reconciliation, decision logging)
 * is what this file guarantees.
 *
 * Behavioral rules preserved from the source brain:
 *   • winning vs losing positions use different prompts
 *   • actions: hold / add / dca / trim / exit / cut / flip (flip = close +
 *     open opposite in the same cycle; dca = losing-monitor average-down)
 *   • stopManagement / newStop → cancel+replace positionTpsl SL (never loosen)
 *   • MIN_OPENING_CONVICTION = 25 weekday / 30 weekend (hard gate), max 3 trims
 *   • capital sizing respects max_capital_usd and account balance
 *   • every decision is persisted (Supabase jsonb replaces IPFS)
 */
import { createHash, randomBytes } from 'node:crypto';
import { agentRowNotionalBudgetUsd } from './budget.js';
import { computeCompositeScore, computeScalperFlags, type FuturesBar, type ScalperFlags } from './brain/computeScalperFlags.js';
import { getSessionContext } from './brain/session-context.js';
import {
  buildOpeningPrompt,
  validateOpeningResponse,
  type OpeningPromptOutput,
} from './brain/prompts/opening-prompt.js';
import {
  buildWinningMonitorPrompt,
  validateWinningMonitorResponse,
} from './brain/prompts/winning-monitor.js';
import {
  buildLosingMonitorPrompt,
  validateLosingMonitorResponse,
} from './brain/prompts/losing-monitor.js';
import { callModel, houseKeyForProvider, parseJsonReply } from './ai/executor.js';
import { planStops, type StopPlan } from './brain/computeStops.js';
import { INTERVAL_MS as COINGLASS_INTERVAL_MS, type CoinglassMarketData } from './data/coinglass.js';
import { getHlPositioning, type HlPositioningContext } from './data/hlPositioning.js';
import { getHlWhalePositions, type WhalePos } from './data/hlWhales.js';
import { getUpcomingCalendarEvents } from './data/macroCalendar.js';
import { getMarketMood, type MarketMoodContext } from './data/marketMood.js';
import {
  getStickyNarrativesBoard,
  type StickyNarrativesBoard,
} from './data/stickyNarratives.js';
import {
  getStickySymbolCatalysts,
  type StickySymbolCatalysts,
} from './data/stickySymbolCatalysts.js';
import { getMacroBetaContext, type MacroBetaContext } from './data/emaList.js';
import {
  cryptoExtensionKeyMetrics,
  cryptoExtensionLogFields,
} from './data/cryptoExtension.js';
import { assetClassOf, isCryptoAsset } from './brain/assetClass.js';
import { isMetalsOptionsAsset } from './data/equityOptions.js';
import {
  BOOK_EXEC_MAX_AGE_MS,
  HlAgentExecutionAdapter,
  effectiveOpenLeverage,
  getBookSnapshot,
  getHlFundingBps,
  getMidPrice,
  isIsolatedOnlyAsset,
  maxSpreadBpsFor,
} from './hl/adapter.js';
import { assessBookForOpen, bookLogFields, type BookSnapshot } from './hl/bookSnapshot.js';
import { SLIPPAGE_MAX } from './hl/slippage.js';
import { recordSignalSnapshot } from './lib/signalSnapshots.js';
import { decryptSecret } from './lib/crypto.js';
import { emptySignals, type CycleHealthSignals } from './lib/agentHealth.js';
import { CLOSE_REASON, classifyExternalCloseReason } from './lib/closeReason.js';
import { config, effectiveDryRun, resolveRiskPerTradePct } from './config.js';
import { liquidityTier } from './hl/liquidityTier.js';
import { getSupabase } from './lib/supabase.js';
import {
  closePositionRow,
  getLastSymbolClose,
  isRecentClose,
  isLossyClose,
  getOpenPositions,
  getRecentMonitorDecisions,
  insertPosition,
  logDecision,
  buildStoredLlmReasoning,
  updatePosition,
  type LastSymbolClose,
} from './stores.js';
import { horizonProfile, type Horizon, type HorizonProfile } from './brain/horizon.js';
import { directionAllows, normalizeDirection, normalizeMandate } from './brain/mandate.js';
import { barIntervalForAgent, marketDataCacheKey } from './data/marketCache.js';
import {
  earningsConvictionGate,
  effectiveRiskProfile,
  openingConvictionGate,
  openingProbeFloor,
  type RiskProfile,
} from './brain/riskProfile.js';
import type { AgentModelChoice, AgentPositionRow, AgentRow } from './types.js';

const MAX_TRIMS_PER_POSITION = 3;
/** Max losing-monitor DCA averages per position. */
const MAX_DCAS_PER_POSITION = 2;
const MIN_ORDER_USD = 15;
/**
 * Test / paper notional caps at/under this produce meaningless $15 probes
 * (risk-parity on dust equity × size 0.1–0.2). Auto-pump opens toward a
 * real clip; still clamped by budgetLeft / max_position / margin below.
 */
const SMALL_NOTIONAL_BUDGET_USD = 500;
/** Target open notional when agent budget ≤ SMALL_NOTIONAL_BUDGET_USD. */
const SMALL_BUDGET_TARGET_OPEN_USD = 250;

/**
 * Minimum meaningful *margin* left on an open position.
 *
 * `max_capital_usd` on shared/copilot agents is a NOTIONAL budget, not wallet
 * margin — so a raw "% of max_capital as margin floor" over-fires on high-lev
 * probes (live BTC Accm 2026-08-10: $20k notional → $1k margin floor vs ~$31
 * opening margin → first trim always escalated to full close).
 *
 * Calibration:
 *   • scalper 1% / swing·investor 0.5% of notional budget (was 5% / 3%)
 *   • never below MIN_ORDER_USD
 *   • never above 50% of this position's opening margin (when known), so a
 *     first partial trim on a small high-lev probe can actually leave a stub
 *
 * Examples (scalper, no opening-margin cap): $1k → $15, $20k → $200, $100k → $1k.
 */
function dustMarginFloorUsd(
  horizon: Horizon,
  maxCapitalUsd: number,
  openingMarginUsd?: number,
): number {
  const pct = horizon === 'scalper' ? 0.01 : 0.005;
  const cap = Number(maxCapitalUsd);
  const scaled = Number.isFinite(cap) && cap > 0 ? pct * cap : 0;
  let floor = Math.max(MIN_ORDER_USD, scaled);
  const openM = Number(openingMarginUsd);
  if (Number.isFinite(openM) && openM > 0) {
    floor = Math.min(floor, Math.max(MIN_ORDER_USD, openM * 0.5));
  }
  return floor;
}

/**
 * True when margin is under the budget-scaled floor AND the position is a
 * reduced stub (already trimmed, or ≤40% of opening notional). Fresh small
 * high-leverage opens are left alone — only post-trim ghosts get swept.
 */
function isMarginDustStub(args: {
  marginUsd: number;
  floorUsd: number;
  sizeUsd: number;
  openingSizeUsd: number;
  trimCount: number;
}): boolean {
  if (!(args.marginUsd >= 0) || !(args.marginUsd < args.floorUsd)) return false;
  if (args.trimCount > 0) return true;
  const open =
    args.openingSizeUsd > 0 && Number.isFinite(args.openingSizeUsd)
      ? args.openingSizeUsd
      : args.sizeUsd;
  return open > 0 && args.sizeUsd <= 0.4 * open;
}

/** Add/DCA size against opening notional so trims don't shrink the pyramid unit. */
function pyramidBaseUsd(tracked: AgentPositionRow): number {
  const opening = tracked.thesis?.opening_size_usd;
  const openNum =
    typeof opening === 'number' && Number.isFinite(opening) && opening > 0
      ? opening
      : tracked.size_usd;
  return Math.max(openNum, tracked.size_usd);
}

function dcaCountOf(tracked: AgentPositionRow): number {
  const n = tracked.thesis?.dca_count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/** Min relative move before we cancel/replace an SL (avoids churn on noise). */
const STOP_REPLACE_MIN_REL = 0.0005; // 5 bps
/** Tighter stop pulls ~25% of the remaining distance to market. */
const TIGHTER_STOP_PULL_FRAC = 0.25;

/** Futures bar nearest at/before `openedAtIso` (series ts are ms). */
function futuresBarNearOpen(
  data: CoinglassMarketData,
  openedAtIso: string,
): FuturesBar | null {
  const series = data.futures?.timeSeries ?? [];
  const openedAt = new Date(openedAtIso).getTime();
  if (!Number.isFinite(openedAt) || series.length === 0) return null;
  let best: FuturesBar | null = null;
  for (const b of series) {
    const ts = Number(b.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts <= openedAt) best = b;
    else break;
  }
  return best ?? series[0];
}

/**
 * CoinGlass funding (bps) on the bar nearest at/before position open.
 * Returns null if funding was missing on that bar.
 */
function marketFundingBpsNearOpen(
  data: CoinglassMarketData,
  openedAtIso: string,
): number | null {
  const bar = futuresBarNearOpen(data, openedAtIso);
  const fr = bar?.funding_rate;
  if (fr == null || !Number.isFinite(Number(fr))) return null;
  return Number(fr) * 10_000;
}

/** Perp-spot premium (bps) on the bar nearest at/before position open. */
function premiumBpsNearOpen(
  data: CoinglassMarketData,
  openedAtIso: string,
): number | null {
  const bar = futuresBarNearOpen(data, openedAtIso);
  const p = bar?.premium;
  return p != null && Number.isFinite(Number(p)) ? Number(p) : null;
}

/**
 * Real liquidation $ over the last HOUR (prompts say "last 1h bar") — on
 * sub-hour series (30m crypto-scalper bars) the trailing bars are summed so
 * the label stays truthful. Velo/CoinGlass semantics: buy-liquidations are
 * forced BUYS (shorts liquidated); sell-liquidations are longs liquidated.
 * Null when the series carries no liq fields (thin symbol) — the prompts
 * render N/A instead of fabricated zeros.
 */
function lastBarLiquidations(
  data: CoinglassMarketData,
): { longs: number; shorts: number } | null {
  const series = data.futures?.timeSeries ?? [];
  const barMs = data.barIntervalMs ?? COINGLASS_INTERVAL_MS;
  const barsPerHour = Math.max(1, Math.round(COINGLASS_INTERVAL_MS / barMs));
  let longsSum = 0;
  let shortsSum = 0;
  let counted = 0;
  for (let i = series.length - 1; i >= 0 && counted < barsPerHour; i -= 1) {
    const b = series[i];
    const longs = Number(b?.sell_liquidations_dollar_volume);
    const shorts = Number(b?.buy_liquidations_dollar_volume);
    if (!Number.isFinite(longs) && !Number.isFinite(shorts)) {
      if (counted > 0) break; // trailing gap after data started — stop summing
      continue; // skip liq-less in-progress bars at the tail
    }
    longsSum += Number.isFinite(longs) ? longs : 0;
    shortsSum += Number.isFinite(shorts) ? shorts : 0;
    counted += 1;
  }
  return counted > 0 ? { longs: longsSum, shorts: shortsSum } : null;
}

/**
 * DVOL change (pts) since position open — honest "since entry" IV delta.
 * Deribit series only spans ~24h, so entries older than the window return
 * null (prompts say so) rather than silently substituting a bar delta.
 */
function ivChangeSinceOpen(
  data: CoinglassMarketData,
  openedAtIso: string,
): number | null {
  const series = data.options?.timeSeries ?? [];
  if (series.length === 0) return null;
  const openedAt = new Date(openedAtIso).getTime();
  if (!Number.isFinite(openedAt)) return null;
  const first = Number(series[0]?.timestamp);
  if (!Number.isFinite(first) || openedAt < first - 60 * 60 * 1000) return null;
  let entryBar: (typeof series)[number] | null = null;
  for (const b of series) {
    const ts = Number(b.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts <= openedAt) entryBar = b;
    else break;
  }
  const entryDvol = Number((entryBar ?? series[0])?.dvol_close);
  const nowDvol = Number(series[series.length - 1]?.dvol_close);
  return Number.isFinite(entryDvol) && Number.isFinite(nowDvol)
    ? nowDvol - entryDvol
    : null;
}

/** cloid = "HTAI" tag (4B) + agent-id hash (4B) + random (8B) → 16-byte hex. */
export function makeAgentCloid(agentId: string): `0x${string}` {
  const idHash = createHash('sha256').update(agentId).digest('hex').slice(0, 8);
  return `0x48544149${idHash}${randomBytes(8).toString('hex')}` as `0x${string}`;
}

export function agentCloidPrefix(agentId: string): string {
  const idHash = createHash('sha256').update(agentId).digest('hex').slice(0, 8);
  return `0x48544149${idHash}`;
}

/**
 * Per-cycle cache of OPENING computations, shared across agents.
 *
 * The opening prompt is a pure function of (symbol, flags, score, price,
 * session) — none of which vary per agent (all agents share one market-data
 * snapshot per cycle) — so two agents with the same symbol + model would burn
 * two identical LLM calls for the same answer. Budget / leverage / margin mode
 * only affect SIZING, applied per-agent AFTER the decision. Monitor prompts are
 * NOT cacheable (they embed per-position entry/PnL/history).
 *
 * We cache the in-flight PROMISE (not the resolved value) so concurrently-run
 * agents (pLimit fan-out) dedupe: the first agent to reach a key stores the
 * pending promise synchronously, every other agent awaits the same one → a
 * single LLM call. Caching the resolved value instead raced (both agents miss
 * before either fills).
 */
export interface OpeningComputation {
  status: 'ok' | 'invalid' | 'error';
  decision?: OpeningPromptOutput;
  reasoning: unknown;
  provider: string;
  model: string;
  error?: string;
  /** Deterministic composite score — logged for conviction calibration. */
  score?: { long: number; short: number };
}

export type OpeningDecisionCache = Map<string, Promise<OpeningComputation>>;

export function openingCacheKey(
  symbol: string,
  choice: AgentModelChoice,
  riskProfile: RiskProfile,
  horizon: Horizon,
  /** Recent close fingerprint so agents with different last closes don't share answers. */
  lastCloseKey = 'none',
  /** Direction/mandate change the prompt — constrained agents can't share free-form answers. */
  mandateKey = 'long_short:active',
): string {
  // Risk profile AND horizon are part of the key: each combination produces
  // a DIFFERENT prompt (gates, flag windows, stop anchors, horizon block) —
  // a scalper must never consume a swing agent's cached answer or vice versa.
  return `${symbol.toUpperCase()}|${choice.provider}|${choice.model}|${riskProfile}|${horizon}|${mandateKey}|${lastCloseKey}`;
}

export interface MonitorContext {
  agent: AgentRow;
  runId: string | null;
  /**
   * Phase-1 cache keyed by SYMBOL (one full series fetch per coin).
   * Entitlement is enforced separately via `validCoinglassKeys` — a junk key
   * never receives a snapshot even if the symbol was fetched for others.
   * Keyed by `marketDataCacheKey(symbol, interval)` — crypto scalpers read
   * the 30m series, everything else 1h (see barIntervalForAgent).
   */
  marketDataBySymbol: Map<string, CoinglassMarketData>;
  /** Plaintext CoinGlass keys that passed this cycle's probe. */
  validCoinglassKeys?: Set<string>;
  /** Cross-agent opening-decision dedupe for this cycle (see type docs). */
  openingCache?: OpeningDecisionCache;
  /**
   * Shared-wallet (copilot) symbol claims for this cycle. Mutated on successful
   * open so a later agent on the same master skips that symbol before LLM.
   */
  sharedWalletClaimedSymbols?: Set<string>;
}

export interface MonitorResult {
  equityUsd: number | null;
  symbolsProcessed: number;
  actionsExecuted: number;
  /** Fallback health counters — never used to mutate agent status. */
  healthSignals: CycleHealthSignals;
}

/**
 * Model API key: house key from the worker env (default). Optional per-agent
 * `model_keys_ciphertext` still takes precedence when present (wire kept;
 * no create-UI — product is house-model + global CoinGlass today).
 */
function resolveModelKey(agent: AgentRow, choice: AgentModelChoice): string {
  const cipher = agent.model_keys_ciphertext?.[choice.provider];
  if (cipher) {
    try {
      return decryptSecret(cipher);
    } catch {
      // Corrupt BYOK entry → fall through to the house key.
    }
  }
  const houseKey = houseKeyForProvider(choice.provider);
  if (!houseKey) {
    throw new Error(
      `No API key available for provider "${choice.provider}" (house env var missing)`,
    );
  }
  return houseKey;
}

function lastCloseBar(data: CoinglassMarketData): { price: number; ts: number } | null {
  // Walk backwards to the last bar with a real close. At a bar boundary the
  // just-opened bar can arrive with no close_price yet (CoinGlass endpoints
  // update out of order in the first seconds), so blindly taking the final bar
  // would return null and silently skip the whole decision. The previous
  // fully-formed bar's close is the correct current reference anyway.
  const bars = data.futures?.timeSeries ?? [];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const b = bars[i];
    const px = b?.close_price;
    if (Number.isFinite(px as number)) return { price: px as number, ts: b.timestamp };
  }
  return null;
}

/**
 * Opening decisions are a function of the bar series; within one bar WINDOW
 * the inputs don't change, so re-asking the LLM burns money and invites
 * flip-flops. Remember the bar window a FLAT / below-conviction answer was
 * produced in (per symbol+model) and skip until the next window.
 *
 * Keyed by the wall-clock bar window (floor(now / INTERVAL_MS)), NOT the
 * latest bar timestamp in the data: with 1h bars + hourly cycles every cycle
 * is a new window, so this memo never skips — it only guards against
 * sub-interval cycle cadences. (Data lag is handled upstream: phase-1 waits
 * up to BAR_CATCHUP_MAX_MINUTES for the new bar before agents run.)
 * In-memory is fine: a worker restart re-asks once. Executed opens don't need
 * the memo (the symbol then has a position and monitors take over).
 */
const flatOpeningBarMemo = new Map<string, number>();

export function currentBarWindowTs(
  windowMs: number = COINGLASS_INTERVAL_MS,
  now = Date.now(),
): number {
  return Math.floor(now / windowMs) * windowMs;
}

function pnlPct(direction: 'LONG' | 'SHORT', entry: number, current: number): number {
  const raw = (current - entry) / entry;
  return (direction === 'LONG' ? raw : -raw) * 100;
}

type StopIntent = 'breakeven' | 'tighter' | null;

/** Map winning/losing monitor fields → a single stop intent (or none). */
function resolveStopIntent(raw: unknown, isWinning: boolean): StopIntent {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (isWinning) {
    const sm = String(d.stopManagement ?? '');
    if (sm === 'move_to_breakeven') return 'breakeven';
    if (sm === 'tighten_stop') return 'tighter';
    return null; // keep_stop / missing
  }
  const ns = String(d.newStop ?? '');
  if (ns === 'breakeven' || ns === 'tighter') return ns;
  return null;
}

/**
 * Compute a candidate SL that NEVER loosens risk vs the current stop.
 * Returns null when there's nothing meaningful to change.
 */
function planStopUpdate(args: {
  intent: StopIntent;
  direction: 'LONG' | 'SHORT';
  entry: number;
  currentPrice: number;
  currentStop: number | null;
}): { nextStop: number; reason: string } | null {
  if (!args.intent) return null;
  const { direction, entry, currentPrice } = args;
  if (!(entry > 0 && currentPrice > 0)) return null;

  const isLong = direction === 'LONG';
  let candidate: number;
  if (args.intent === 'breakeven') {
    candidate = entry;
  } else {
    // tighter: pull stop 25% of the way from currentStop (or a soft default
    // below/above entry) toward the market — always reducing risk distance.
    const fallback =
      args.currentStop && args.currentStop > 0
        ? args.currentStop
        : isLong
          ? entry * 0.98
          : entry * 1.02;
    candidate = fallback + (currentPrice - fallback) * TIGHTER_STOP_PULL_FRAC;
  }

  // Never loosen: long stop only rises; short stop only falls.
  if (args.currentStop && args.currentStop > 0) {
    candidate = isLong
      ? Math.max(candidate, args.currentStop)
      : Math.min(candidate, args.currentStop);
  }

  // Must stay on the protective side of market (with a small buffer).
  const buf = currentPrice * STOP_REPLACE_MIN_REL;
  if (isLong) {
    if (candidate >= currentPrice - buf) return null;
  } else if (candidate <= currentPrice + buf) {
    return null;
  }

  // Skip no-op / noise-level moves.
  if (args.currentStop && args.currentStop > 0) {
    const rel = Math.abs(candidate - args.currentStop) / args.currentStop;
    if (rel < STOP_REPLACE_MIN_REL) return null;
  }

  return { nextStop: candidate, reason: args.intent };
}

/** Protective SL/TP for a flipped position — mirror prior risk distance when known. */
function flipProtectiveLevels(
  direction: 'LONG' | 'SHORT',
  entry: number,
  prev: AgentPositionRow,
): { stop: number; takeProfit: number } {
  let riskFrac = 0.02;
  if (
    prev.stop_loss != null &&
    prev.stop_loss > 0 &&
    prev.entry_price > 0
  ) {
    riskFrac = Math.abs(prev.entry_price - prev.stop_loss) / prev.entry_price;
    riskFrac = Math.min(0.05, Math.max(0.005, riskFrac));
  }
  const rewardFrac = Math.min(0.1, riskFrac * 2);
  if (direction === 'LONG') {
    return { stop: entry * (1 - riskFrac), takeProfit: entry * (1 + rewardFrac) };
  }
  return { stop: entry * (1 + riskFrac), takeProfit: entry * (1 - rewardFrac) };
}

function resolveFlipSide(
  trackedDirection: 'LONG' | 'SHORT',
  raw: unknown,
): 'LONG' | 'SHORT' {
  const body = raw as { flipSide?: string; side?: string };
  const hinted = (body.flipSide ?? body.side ?? '').toString().toUpperCase();
  if (hinted === 'LONG' || hinted === 'SHORT') {
    // Ignore a same-side hint — flip must reverse.
    if (hinted !== trackedDirection) return hinted;
  }
  return trackedDirection === 'LONG' ? 'SHORT' : 'LONG';
}

export async function executeAgentMonitoring(ctx: MonitorContext): Promise<MonitorResult> {
  const { agent, runId } = ctx;
  // Backend key generation historically stored the hex without the 0x prefix
  // (hexbytes >= 1.0 drops it); viem requires it. Normalize on read so rows
  // created before the backend fix keep working.
  const rawKey = decryptSecret(agent.hl_agent_key_ciphertext);
  const agentPrivateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const adapter = new HlAgentExecutionAdapter({
    agentPrivateKey,
    masterAddress: agent.hl_master_address,
    subaccountAddress: agent.hl_subaccount_address,
    agentConfig: agent.config,
  });

  let actionsExecuted = 0;

  // ── Reconciliation: adopt reality before deciding anything ───────────────
  // Tracked rows whose on-chain position vanished were closed externally
  // (stop/TP fill, liquidation, or manual). Classify close_reason from
  // tracked levels + fills; never "re-open" or fight the user.
  const [trackedOpen, livePositions] = await Promise.all([
    getOpenPositions(agent.id),
    adapter.getAllPositions(),
  ]);
  const liveBySymbol = new Map(livePositions.map((p) => [p.symbol.toUpperCase(), p]));

  const stillOpen: AgentPositionRow[] = [];
  for (const row of trackedOpen) {
    const live = liveBySymbol.get(row.symbol.toUpperCase());
    const stillOurs =
      !!live &&
      live.direction === row.direction &&
      (await adapter.isTrackedLiveStillOurs(row, live).catch(() =>
        // Fail closed on identity errors only when entry clearly diverged;
        // otherwise keep monitoring (legacy behavior).
        live.entryPrice > 0 &&
          row.entry_price > 0 &&
          Math.abs(live.entryPrice - row.entry_price) / row.entry_price <= 0.03,
      ));

    if (!stillOurs) {
      const closed = await adapter
        .estimateClosedPnl({
          symbol: row.symbol,
          direction: row.direction,
          entryPrice: row.entry_price,
          sizeUsd: row.size_usd,
          openedAt: row.opened_at,
        })
        .catch(() => ({
          pnlUsd: 0,
          closePrice: null as number | null,
          source: 'mark' as const,
          liquidated: false,
        }));
      const closeReason = classifyExternalCloseReason({
        closePrice: closed.closePrice,
        stopLoss: row.stop_loss,
        takeProfit: row.take_profit,
        liquidated: closed.liquidated,
      });
      await closePositionRow({
        id: row.id,
        status: 'CLOSED_BY_USER',
        closeReason,
        closePrice: closed.closePrice,
        realizedPnl: closed.pnlUsd,
      });
      await logDecision({
        agentId: agent.id,
        runId,
        symbol: row.symbol,
        type: 'reconciled_closed',
        decision: {
          previous: row.direction,
          sizeUsd: row.size_usd,
          realizedPnl: closed.pnlUsd,
          closePrice: closed.closePrice,
          pnlSource: closed.source,
          closeReason,
          trackedStop: row.stop_loss,
          trackedTakeProfit: row.take_profit,
          liquidated: closed.liquidated,
          // Same side still live but identity failed → user reopen after flatten.
          identityRejected: !!(live && live.direction === row.direction),
          liveEntry: live?.entryPrice ?? null,
          trackedEntry: row.entry_price,
        },
      });
      // Cycle-start claim seed includes this agent's own opens. Free the
      // symbol so we can considerOpening in the same cycle after an external
      // close (TP/SL/manual) instead of false skipped_peer_symbol.
      ctx.sharedWalletClaimedSymbols?.delete(row.symbol.toUpperCase());
    } else {
      // Keep tracked entry/size in sync with HL when still ours.
      // Entry: add/DCA avg drift. Size: manual user trim/add (worker already
      // writes size on its own trims/adds). Use entry-notional (units×entry),
      // not mark positionValue — price moves must not rewrite size_usd.
      // Portfolio bot badge matches size within ~25%; stale size after a
      // manual cut hides the icon even though we still manage the ticker.
      if (live) {
        const patch: { entry_price?: number; size_usd?: number } = {};
        if (
          live.entryPrice > 0 &&
          Math.abs(live.entryPrice - row.entry_price) / Math.max(row.entry_price, 1e-9) > 0.0005
        ) {
          patch.entry_price = live.entryPrice;
        }
        const liveEntryNotional = live.sizeUnits * live.entryPrice;
        if (
          liveEntryNotional > 0 &&
          row.size_usd > 0 &&
          Math.abs(liveEntryNotional - row.size_usd) / row.size_usd > 0.005
        ) {
          patch.size_usd = liveEntryNotional;
        }
        if (Object.keys(patch).length > 0) {
          await updatePosition(row.id, patch).catch(() => undefined);
          if (patch.entry_price != null) row.entry_price = patch.entry_price;
          if (patch.size_usd != null) row.size_usd = patch.size_usd;
        }
      }
      stillOpen.push(row);
    }
  }

  // Equity floor (same as activate MIN_HL_BALANCE): once live, grifters can
  // drain the wallet below $50 and keep burning house LLM forever. After
  // reconcile (no LLM), pause if equity is known and below the floor — open
  // HL positions keep their exchange TP/SL; user must top up + resume.
  const equityBal = await adapter.getBalance().catch(() => null);
  const equityUsd = equityBal?.accountValueUsd ?? null;
  if (
    equityUsd != null &&
    Number.isFinite(equityUsd) &&
    equityUsd < config.minHlBalanceUsd
  ) {
    const { error: pauseErr } = await getSupabase()
      .from('ai_agents')
      .update({ status: 'paused' })
      .eq('id', agent.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error(
        `[equity-floor] failed to pause agent ${agent.id}:`,
        pauseErr.message,
      );
    } else {
      console.warn(
        `[equity-floor] auto-paused agent ${agent.id} equity=$${equityUsd.toFixed(2)} < $${config.minHlBalanceUsd}`,
      );
    }
    await logDecision({
      agentId: agent.id,
      runId,
      symbol: null,
      type: 'auto_paused_low_equity',
      decision: {
        equityUsd,
        minHlBalanceUsd: config.minHlBalanceUsd,
        openPositions: stillOpen.length,
        reason:
          'Account equity fell below the live minimum — agent paused. Deposit and resume to continue.',
      },
    });
    return {
      equityUsd,
      symbolsProcessed: 0,
      actionsExecuted: 0,
      healthSignals: emptySignals(agent.config.symbols.length),
    };
  }

  // Budget headroom is entry-basis by design (winners are never force-trimmed
  // for outgrowing max_capital_usd), BUT new risk must not stack on top of a
  // pumped position: headroom consumption per position = the LARGER of entry
  // notional and live mark notional, so growth eats the budget for NEW
  // opens/adds without touching the existing position.
  const effectiveNotional = (r: AgentPositionRow): number => {
    const live = liveBySymbol.get(r.symbol.toUpperCase());
    return live && live.direction === r.direction
      ? Math.max(r.size_usd, live.notionalUsd)
      : r.size_usd;
  };
  const trackedNotional = () => stillOpen.reduce((s, r) => s + effectiveNotional(r), 0);
  const sessionContext = getSessionContext();
  // Trading-horizon profile — parameterizes windows/stops/temperament below.
  const hp = horizonProfile(agent.config.horizon);
  // Relative calendar slice (globally cached; in-process memo) — today's date
  // + upcoming US holidays / high-impact macro events for the prompts.
  sessionContext.upcomingEvents = await getUpcomingCalendarEvents().catch(() => []);
  // Platform-wide context blocks (globally cached; identical for all agents).
  // Crypto mood/positioning are gated per-symbol at prompt build time.
  const hlPositioning = await getHlPositioning().catch(() => null);
  const marketMood = await getMarketMood().catch(() => null);
  const stickyNarratives = await getStickyNarrativesBoard().catch(() => null);
  const whalePositions = await getHlWhalePositions().catch(() => null);
  const macroBeta = await getMacroBetaContext().catch(
    (): MacroBetaContext => ({ sp500: null, qqq: null, dxy: null }),
  );

  // Entitlement: in global mode (house CoinGlass Standard key) every agent is
  // entitled — no personal key needed. In BYOK mode the agent must hold a key
  // that passed this cycle's probe. Snapshot itself is shared by SYMBOL.
  let agentCgKey: string | null = null;
  if (!config.coinglassGlobalMode && agent.coinglass_key_ciphertext) {
    try {
      agentCgKey = decryptSecret(agent.coinglass_key_ciphertext);
    } catch {
      agentCgKey = null;
    }
  }
  const keyEntitled =
    config.coinglassGlobalMode ||
    (agentCgKey != null &&
      (ctx.validCoinglassKeys == null || ctx.validCoinglassKeys.has(agentCgKey)));

  // ── Per-symbol decision loop ─────────────────────────────────────────────
  let symbolsProcessed = 0;
  const healthSignals = emptySignals(agent.config.symbols.length);
  for (const symbol of agent.config.symbols) {
    const sym = symbol.toUpperCase();
    const dataKey = marketDataCacheKey(sym, barIntervalForAgent(sym, agent.config.horizon));
    const data = keyEntitled ? ctx.marketDataBySymbol.get(dataKey) : undefined;
    if (!data) {
      healthSignals.noData += 1;
      await logDecision({
        agentId: agent.id, runId, symbol: sym, type: 'skipped_no_data',
        decision: {
          reason: config.coinglassGlobalMode
            ? 'market data unavailable this cycle'
            : !agentCgKey
              ? 'missing or invalid CoinGlass API key'
              : !keyEntitled
                ? 'CoinGlass API key failed entitlement probe'
                : 'market data unavailable this cycle',
        },
      });
      continue;
    }
    const lastBar = lastCloseBar(data);
    if (!lastBar) {
      // Never silently drop a symbol — log it so a gap is always explainable.
      healthSignals.noData += 1;
      await logDecision({
        agentId: agent.id, runId, symbol: sym, type: 'skipped_no_price',
        decision: { reason: 'no usable close price in market data this cycle' },
      });
      continue;
    }
    // Decisions must see the REAL market price. The bar close can be up to an
    // interval stale and used to drive P&L %, stop planning and close prices
    // while HL's live mark had already moved. Bars remain the flags' input.
    const liveMid = await getMidPrice(sym).catch(() => null);
    const currentPrice = liveMid ?? lastBar.price;
    const priceSource = liveMid != null ? 'hl_mid' : 'bar_close';
    // Horizon knobs: opening memo uses openingWindowMs (1h all horizons);
    // flag lookbacks scale with horizon (swing ×4, investor ×6).
    const barWindowTs = currentBarWindowTs(hp.openingWindowMs);
    symbolsProcessed += 1;

    // Sub-hour bars (crypto scalpers, 30m): multiply BOTH the hist window and
    // the horizon scale so every lookback keeps its 1h-tuned WALL-CLOCK span
    // ("3-bar flow" stays 3 hours; 60-bar percentiles stay ~2.5 days).
    const barFactor = Math.max(
      1,
      Math.round(COINGLASS_INTERVAL_MS / (data.barIntervalMs ?? COINGLASS_INTERVAL_MS)),
    );
    const flags = computeScalperFlags(data, 60 * barFactor, hp.flagWindowScale * barFactor);
    const tracked = stillOpen.find((r) => r.symbol.toUpperCase() === sym) ?? null;

    // Live L2 snapshot (cycle-cached per coin, minutes-old is fine here):
    // prompt context + signal snapshot. Execution re-pulls a seconds-fresh one.
    const book = await getBookSnapshot(sym);

    // Signal + outcome logging (item 1): one row per symbol×interval×horizon
    // per cycle, deduped in-process across agents. Fire-and-forget.
    void recordSignalSnapshot({
      cycleTs: barWindowTs,
      symbol: sym,
      barIntervalMs: data.barIntervalMs ?? COINGLASS_INTERVAL_MS,
      horizon: hp.key,
      tradingEnv: agent.trading_env,
      price: currentPrice,
      priceSource,
      barCloseTs: lastBar.ts,
      barClose: lastBar.price,
      flags,
      score: computeCompositeScore(flags),
      book,
    });

    // Orphan guard for maker-first opens: a crash mid ALO-wait leaves a
    // resting order tagged with our prefix that could fill unattended.
    if (!effectiveDryRun(agent)) {
      await adapter.cancelStaleAgentOrders(sym, agentCloidPrefix(agent.id)).catch(() => 0);
    }

    try {
      if (tracked) {
        actionsExecuted += await monitorPosition({
          agent,
          runId,
          adapter,
          tracked,
          flags,
          marketData: data,
          currentPrice,
          priceSource,
          etfFlows: data.etfFlows ?? null,
          hlPositioning: isCryptoAsset(sym) ? hlPositioning : null,
          whalePositions,
          stickyNarratives,
          stickySymbolCatalysts: await getStickySymbolCatalysts(sym).catch(() => null),
          horizonP: hp,
          sessionContext,
          agentTrackedNotionalUsd: trackedNotional(),
          healthSignals,
          onSizeChanged: (nextSizeUsd) => {
            tracked.size_usd = nextSizeUsd;
          },
          onClosed: () => {
            const idx = stillOpen.findIndex((r) => r.id === tracked.id);
            if (idx >= 0) stillOpen.splice(idx, 1);
          },
          onOpened: (row) => {
            stillOpen.push(row);
          },
        });
      } else {
        actionsExecuted += await considerOpening({
          agent, runId, adapter, sym, flags, data, currentPrice, sessionContext,
          barWindowTs,
          book,
          hlPositioning: isCryptoAsset(sym) ? hlPositioning : null,
          marketMood: isCryptoAsset(sym) ? marketMood : null,
          stickyNarratives,
          stickySymbolCatalysts: await getStickySymbolCatalysts(sym).catch(() => null),
          whalePositions,
          macroBeta: isCryptoAsset(sym) ? null : macroBeta,
          horizonP: hp,
          trackedNotionalUsd: trackedNotional(),
          openingCache: ctx.openingCache,
          sharedWalletClaimedSymbols: ctx.sharedWalletClaimedSymbols,
          healthSignals,
          onOpened: (row) => {
            stillOpen.push(row);
            ctx.sharedWalletClaimedSymbols?.add(sym);
          },
        });
      }
    } catch (err) {
      healthSignals.decideError += 1;
      await logDecision({
        agentId: agent.id, runId, symbol: sym, type: 'error',
        decision: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const equity = await adapter.getBalance().then((b) => b.accountValueUsd).catch(() => null);
  return { equityUsd: equity, symbolsProcessed, actionsExecuted, healthSignals };
}

// ── Opening branch ─────────────────────────────────────────────────────────

async function considerOpening(args: {
  agent: AgentRow;
  runId: string | null;
  adapter: HlAgentExecutionAdapter;
  sym: string;
  flags: ScalperFlags;
  data: CoinglassMarketData;
  currentPrice: number;
  /** Wall-clock bar window of this cycle (dedupe key for flat retries). */
  barWindowTs: number;
  /** Live HL L2 snapshot (prompt context; execution refetches fresher). */
  book?: BookSnapshot | null;
  hlPositioning: HlPositioningContext | null;
  marketMood: MarketMoodContext | null;
  /** Global sticky macro/theme board (2×/day); all asset classes. */
  stickyNarratives?: StickyNarrativesBoard | null;
  stickySymbolCatalysts?: StickySymbolCatalysts | null;
  whalePositions: WhalePos[] | null;
  macroBeta?: MacroBetaContext | null;
  horizonP: HorizonProfile;
  sessionContext: ReturnType<typeof getSessionContext>;
  trackedNotionalUsd: number;
  openingCache?: OpeningDecisionCache;
  sharedWalletClaimedSymbols?: Set<string>;
  healthSignals: CycleHealthSignals;
  onOpened: (row: AgentPositionRow) => void;
}): Promise<number> {
  const { agent, runId, adapter, sym, flags, currentPrice } = args;
  const hs = args.healthSignals;

  // Another copilot on this wallet already claimed / holds this symbol.
  if (args.sharedWalletClaimedSymbols?.has(sym)) {
    hs.decideOk += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_peer_symbol',
      decision: { reason: 'another agent on this wallet already owns or claimed this symbol' },
    });
    return 0;
  }

  // Copilot symbol-conflict guard: the user (or peer) is trading this coin → stay out.
  if (await adapter.hasUserConflict(sym, false)) {
    hs.decideOk += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_user_conflict',
      decision: { reason: 'account already holds a position in this symbol' },
    });
    args.sharedWalletClaimedSymbols?.add(sym);
    return 0;
  }

  // Budget: remaining headroom under notional cap (dedicated: funding × lev).
  const notionalBudget = agentRowNotionalBudgetUsd(agent);
  const budgetLeft = notionalBudget - args.trackedNotionalUsd;
  if (budgetLeft < MIN_ORDER_USD) {
    hs.decideOk += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_budget',
      decision: {
        budgetLeft,
        maxCapitalUsd: agent.config.max_capital_usd,
        notionalBudgetUsd: notionalBudget,
        mode: agent.mode,
      },
    });
    return 0;
  }

  // Recent close on this symbol: lossy → cooldown; any recent close (incl.
  // winning user flatten) → LAST CLOSE card on the opening prompt.
  const lastCloseRaw = await getLastSymbolClose({ agentId: agent.id, symbol: sym }).catch(
    () => null,
  );
  if (lastCloseRaw && isLossyClose(lastCloseRaw)) {
    const sinceMs = Date.now() - new Date(lastCloseRaw.closedAt).getTime();
    if (sinceMs >= 0 && sinceMs < args.horizonP.reopenCooldownMs) {
      hs.decideOk += 1;
      {
        const remainingMs = args.horizonP.reopenCooldownMs - sinceMs;
        await logDecision({
          agentId: agent.id, runId, symbol: sym, type: 'skipped_cooldown',
          decision: {
            reason: 'loss-close cooldown active — no fresh opens on this symbol yet',
            lastCloseReason: lastCloseRaw.closeReason,
            lastClosedAt: lastCloseRaw.closedAt,
            cooldownMinutes: Math.round(args.horizonP.reopenCooldownMs / 60_000),
            // Honest remainder (can be 0 when <60s left). Do not floor to 1 —
            // that made showcase copy imply an imminent open on an hourly cycle.
            remainingMinutes: Math.max(0, Math.ceil(remainingMs / 60_000)),
            remainingMs: Math.max(0, Math.round(remainingMs)),
            endsSoon: remainingMs < 5 * 60_000,
          },
        });
      }
      return 0;
    }
  }
  const lastCloseForPrompt: LastSymbolClose | null =
    lastCloseRaw && isRecentClose(lastCloseRaw.closedAt, args.horizonP.reopenCooldownMs)
      ? lastCloseRaw
      : null;

  // Margin preflight: skip LLM when free collateral can't fund the minimum
  // notional at THIS symbol's effective leverage (agent cap ∩ asset HL max).
  // Uses adapter free-margin (unified-aware), not raw HL withdrawable.
  // Horizon may cap open leverage below the agent cap (investor ≤3x — wide
  // stops need survivable liq distance; matches the prompt's leverage line).
  const leverageCap = Math.max(1, agent.config.leverage_cap);
  let effectiveLev = await effectiveOpenLeverage(leverageCap, sym);
  if (args.horizonP.maxOpenLeverage != null) {
    effectiveLev = Math.min(effectiveLev, args.horizonP.maxOpenLeverage);
  }
  const bal = await adapter.getBalance().catch(() => null);
  if (bal) {
    const freeMargin = bal.freeMarginUsd;
    const maxNotionalByMargin = freeMargin * effectiveLev * 0.95;
    if (maxNotionalByMargin < MIN_ORDER_USD) {
      hs.decideOk += 1;
      await logDecision({
        agentId: agent.id, runId, symbol: sym, type: 'skipped_margin',
        decision: {
          freeMarginUsd: freeMargin,
          accountMode: bal.accountMode,
          accountValueUsd: bal.accountValueUsd,
          leverageCap,
          effectiveLeverage: effectiveLev,
          maxNotionalByMargin,
          minOrderUsd: MIN_ORDER_USD,
        },
      });
      return 0;
    }
  }

  const modelChoice = agent.config.models.opening;
  // Thin hours (Fri 19:00–Sun 21:00 UTC) force standard — never mutates DB.
  const riskProfile = effectiveRiskProfile(agent.config.risk_profile);
  const hp = args.horizonP;
  const direction = normalizeDirection(agent.config.direction);
  const mandate = normalizeMandate(agent.config.mandate);
  const cacheKey = openingCacheKey(
    sym,
    modelChoice,
    riskProfile,
    hp.key,
    lastCloseForPrompt?.closedAt ?? 'none',
    `${direction}:${mandate}`,
  );

  // Same bar window already produced a no-trade answer for this symbol+model
  // — the LLM's inputs haven't changed, so a re-ask is a paid coin-flip.
  // With 1h bars + hourly cycles every cycle is a fresh window, so this only
  // fires on sub-interval cadences (e.g. adaptive re-runs within the hour).
  if (flatOpeningBarMemo.get(cacheKey) === args.barWindowTs) {
    hs.decideOk += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_no_new_bar',
      decision: {
        // User-facing copy lives in the app (horizon check window) — do not
        // say "no new bar" here; that reads like a market-data outage.
        reason: `opening already decided for this ${hp.key} check window`,
        horizon: hp.key,
        barWindowTs: args.barWindowTs,
        model: `${modelChoice.provider}/${modelChoice.model}`,
      },
    });
    return 0;
  }

  // Compute-once, in-flight promise cache (see OpeningDecisionCache docs). The
  // get→set below has no await between it, so concurrent agents can't both
  // miss: the first stores the pending promise, the rest await it.
  const compute = (): Promise<OpeningComputation> =>
    (async (): Promise<OpeningComputation> => {
      const score = computeCompositeScore(flags);
      // Session-range stop/TP anchors for BOTH sides (the model picks the
      // direction). Leverage-neutral (lev=1): the prompt is cached across
      // agents with different leverage caps; per-position liquidation safety
      // is handled by the monitor's leverage-risk context and HL triggers.
      let stopAnchors: { long: StopPlan; short: StopPlan } | null = null;
      try {
        const bars = args.data.futures?.timeSeries ?? [];
        const assetClass = assetClassOf(sym);
        stopAnchors = {
          long: planStops(currentPrice, 'long', bars, hp.stopHint, 1, assetClass),
          short: planStops(currentPrice, 'short', bars, hp.stopHint, 1, assetClass),
        };
      } catch {
        stopAnchors = null; // anchors are advisory — never block the decision
      }
      const promptInput = {
        asset: sym,
        flags,
        score,
        currentPrice,
        stopAnchors,
        etfFlows: args.data.etfFlows ?? null,
        hlPositioning: args.hlPositioning,
        marketMood: args.marketMood,
        stickyNarratives: args.stickyNarratives ?? null,
        stickySymbolCatalysts: args.stickySymbolCatalysts ?? null,
        lastSymbolClose: lastCloseForPrompt,
        whalePositions: args.whalePositions,
        optionsPositioning: args.data.optionsPositioning ?? null,
        ema: args.data.ema ?? null,
        earnings: args.data.earnings ?? null,
        equityOptions: args.data.equityOptions ?? null,
        equityDaily: args.data.equityDaily ?? null,
        macroBeta: args.macroBeta ?? null,
        cryptoExtension: isCryptoAsset(sym) ? args.data.cryptoExtension ?? null : null,
        book: args.book ?? null,
        riskProfile,
        horizon: hp.key,
        direction,
        mandate,
        barIntervalLabel:
          (args.data.barIntervalMs ?? COINGLASS_INTERVAL_MS) === 30 * 60 * 1000
            ? ('30m' as const)
            : ('1h' as const),
        sessionContext: args.sessionContext,
      };
      const prompt = buildOpeningPrompt(promptInput);
      let llm;
      try {
        const modelKey = resolveModelKey(agent, modelChoice);
        llm = await callModel({ choice: modelChoice, apiKey: modelKey, prompt });
      } catch (err) {
        return {
          status: 'error',
          reasoning: buildStoredLlmReasoning({
            provider: modelChoice.provider,
            model: modelChoice.model,
            prompt,
          }),
          provider: modelChoice.provider,
          model: modelChoice.model,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const reasoningOk = buildStoredLlmReasoning({
        provider: llm.provider,
        model: llm.model,
        latencyMs: llm.latencyMs,
        prompt,
      });
      const reasoningInvalid = buildStoredLlmReasoning({
        provider: llm.provider,
        model: llm.model,
        latencyMs: llm.latencyMs,
        response: llm.content,
        prompt,
      });
      try {
        const decision = validateOpeningResponse(parseJsonReply(llm.content), promptInput);
        return {
          status: 'ok', decision, reasoning: reasoningOk,
          provider: llm.provider, model: llm.model,
          score: { long: score.longScore, short: score.shortScore },
        };
      } catch (err) {
        return {
          status: 'invalid',
          reasoning: reasoningInvalid,
          provider: llm.provider,
          model: llm.model,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

  let compPromise = args.openingCache?.get(cacheKey);
  if (!compPromise) {
    compPromise = compute();
    args.openingCache?.set(cacheKey, compPromise);
  }
  const comp = await compPromise;

  if (comp.status === 'error') {
    // Transient LLM/network failure — surface per-agent; retried next cycle.
    hs.decideError += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'error',
      decision: { message: comp.error }, reasoning: comp.reasoning,
      provider: comp.provider, model: comp.model,
    });
    return 0;
  }
  if (comp.status === 'invalid') {
    // Model replied but failed schema — not a provider outage.
    hs.decideOk += 1;
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'opening_invalid',
      decision: { error: comp.error }, reasoning: comp.reasoning,
      provider: comp.provider, model: comp.model,
    });
    return 0;
  }

  const decision = comp.decision as OpeningPromptOutput;
  const reasoning = comp.reasoning;
  // Horizon floor stacked on the risk-profile gate — mirrors opening-prompt.
  const minConviction = Math.max(
    openingConvictionGate(args.sessionContext.isWeekend, riskProfile),
    hp.minConvictionGate ?? 0,
  );
  // Exploratory-probe tier: a direction with conviction just under the gate
  // still trades at the validator-capped 0.1 size. Keeps agents engaged in
  // mildly-unclear regimes instead of weeks of FLAT. Same helpers feed the
  // opening prompt, so prompt text and worker gate can't drift.
  // Investor disables the tier: probe-conviction multi-week holds are noise.
  const probeFloor = hp.allowProbes ? openingProbeFloor(minConviction) : minConviction;
  const isProbe =
    decision.decision !== 'FLAT' &&
    decision.conviction >= probeFloor &&
    decision.conviction < minConviction;

  if (decision.decision === 'FLAT' || decision.conviction < probeFloor) {
    hs.decideOk += 1;
    flatOpeningBarMemo.set(cacheKey, args.barWindowTs);
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'opening_flat',
      decision: {
        ...decision,
        compositeScore: comp.score ?? null,
        ...cryptoExtensionLogFields(args.data.cryptoExtension),
        minConviction,
        probeFloor,
        riskProfile,
        sessionFloor: args.sessionContext.isWeekend ? 'thin_hours' : 'normal',
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  // ── Worker-enforced guards (prompt states these; models ignore soft text —
  // observed live: TSLA opened at conviction 24 with earnings the next day).
  // Direction mandate: user constrained the agent to one side — a disallowed
  // direction is treated as FLAT (the prompt already says FLAT is the
  // opposite-side expression, but soft text alone is ignorable).
  if (!directionAllows(direction, decision.decision as 'LONG' | 'SHORT')) {
    hs.decideOk += 1;
    flatOpeningBarMemo.set(cacheKey, args.barWindowTs);
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_direction_mandate',
      decision: {
        reason: `agent is ${direction} — ${decision.decision} opens are not allowed`,
        modelDecision: decision.decision,
        conviction: decision.conviction,
        direction,
        mandate,
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }
  // Earnings window: fresh equity opens within 48h need conviction above the
  // profile gate (standard 50 / aggressive 35 — the user's own risk dial).
  const earnings = args.data.earnings ?? null;
  const earningsGate = earningsConvictionGate(riskProfile);
  if (earnings?.within48h && decision.conviction < earningsGate) {
    hs.decideOk += 1;
    flatOpeningBarMemo.set(cacheKey, args.barWindowTs);
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_earnings_window',
      decision: {
        reason: `earnings ${earnings.nextDate} within 48h — fresh opens need conviction ≥ ${earningsGate}`,
        modelDecision: decision.decision,
        conviction: decision.conviction,
        nextEarnings: earnings.nextDate,
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }
  // Trend filter (swing/investor): counter-trend vs the trend stack needs
  // conviction ≥ 50. Equity/metals prefer the REAL daily 20/50/200d stack
  // (Massive closes) over perp-venue EMAs — mirrors the opening prompt.
  // Scalper exempt — hours-scale fades are legitimate.
  const dailyStack = args.data.equityDaily?.stack;
  const emaStack =
    dailyStack === 'bullish' || dailyStack === 'bearish'
      ? dailyStack
      : args.data.ema?.stack ?? null;
  const stackSide =
    emaStack === 'bullish' ? 'LONG' : emaStack === 'bearish' ? 'SHORT' : null;
  if (
    hp.key !== 'scalper' &&
    stackSide != null &&
    decision.decision !== stackSide &&
    decision.conviction < 50
  ) {
    hs.decideOk += 1;
    flatOpeningBarMemo.set(cacheKey, args.barWindowTs);
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_trend_filter',
      decision: {
        reason: `${dailyStack === emaStack ? 'daily 20/50/200d' : '1d/1w EMA'} stack is ${emaStack} — counter-trend ${decision.decision} needs conviction ≥ 50`,
        modelDecision: decision.decision,
        conviction: decision.conviction,
        emaStack,
        stackSource: dailyStack === emaStack ? 'massive_daily' : 'coinglass_ema',
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  // Valid directional reply from the model — count as healthy decide even if
  // the subsequent HL place fails (that is execution, not CG/LLM outage).
  hs.decideOk += 1;

  // ── Sizing: RISK PARITY ────────────────────────────────────────────────
  // Equal dollar-risk-at-stop per position, NOT equal notional or margin:
  //   risk$  = equity × tierRisk% × (size band / 0.8)
  //   notional = risk$ / stop-distance%
  // Tier: BTC/ETH + mid-liquid → 4%; thin alts → 2% (shared liquidity catalog).
  // Stops are session-range derived, so stop distance encodes each asset's
  // volatility → volatile names get smaller notionals automatically.
  // Leverage plays NO role in sizing (in cross mode per-name leverage is
  // capital efficiency, not risk) — it only bounds feasibility below.
  // Falls back to the legacy budget-fraction formula when equity or stop
  // data is unavailable.
  const perPositionCap = agent.config.max_position_usd;
  const equityUsd =
    bal && Number.isFinite(bal.accountValueUsd) && bal.accountValueUsd > 0
      ? bal.accountValueUsd
      : null;
  const rawStopDist =
    currentPrice > 0 && Number.isFinite(decision.stop_price) && decision.stop_price > 0
      ? Math.abs(currentPrice - decision.stop_price) / currentPrice
      : null;
  // Sanity clamp: an absurdly tight stop must not inflate notional (models
  // could game size via stops), and an absurdly wide one must not zero it.
  const stopDistPct =
    rawStopDist != null ? Math.min(0.10, Math.max(0.005, rawStopDist)) : null;

  const riskPerTradePct = resolveRiskPerTradePct(sym);
  const sizeLiquidityTier = liquidityTier(sym);

  let riskUsd: number | null = null;
  let sizingMode: 'risk_parity' | 'legacy' = 'legacy';
  let sizeUsd: number;
  if (equityUsd != null && stopDistPct != null) {
    riskUsd = equityUsd * (riskPerTradePct / 100) * (decision.size / 0.8);
    sizeUsd = riskUsd / stopDistPct;
    sizingMode = 'risk_parity';
  } else {
    sizeUsd = decision.size * budgetLeft;
  }
  // Floor tiny-but-valid sizes (probes on small accounts) up to HL's minimum
  // BEFORE the caps — the caps below then decide if even the minimum fits.
  sizeUsd = Math.max(MIN_ORDER_USD, sizeUsd);

  // Small-budget pump: ≤$500 notional caps + probe fractions land on dust
  // (~$15) that can't trim and barely moves PnL. Concentrate into a
  // meaningful clip of remaining headroom (still subject to max_position /
  // margin clamps below). Serious ≥$500 budgets keep pure risk-parity.
  let smallBudgetPump: { from: number; to: number; target: number } | null = null;
  if (notionalBudget > 0 && notionalBudget <= SMALL_NOTIONAL_BUDGET_USD) {
    const target = Math.min(
      budgetLeft,
      Math.max(
        MIN_ORDER_USD,
        Math.min(SMALL_BUDGET_TARGET_OPEN_USD, notionalBudget),
      ),
    );
    if (sizeUsd + 1e-9 < target) {
      smallBudgetPump = { from: sizeUsd, to: target, target };
      sizeUsd = target;
    }
  }

  // ── ISOLATED opens: leverage = liquidation-buffer dial, not a choice ─────
  // Isolated liq distance ≈ 1/leverage and the shared pool does NOT back the
  // position — so for the SAME notional (same PnL), 40x posts a ~2.5% buffer
  // while 10x posts ~10%, strictly safer at zero cost when margin is free.
  // Pick the LOWEST leverage that achieves a healthy buffer
  // (max(ISOLATED_LIQ_BUFFER_PCT, 2× stop distance)) and still fits free
  // margin; the user's cap and the stop-before-liq ceiling
  // (lev ≤ 1/(1.5×stop)) bound it. Cross positions are untouched — the
  // wallet-leverage guard below governs pool risk.
  let openLev = effectiveLev;
  let isolatedLev: number | null = null;
  const willBeIsolated =
    (agent.config.margin_mode ?? 'cross') === 'isolated' ||
    (await isIsolatedOnlyAsset(sym).catch(() => false));
  if (willBeIsolated && stopDistPct != null) {
    const stopSafeCap = Math.max(1, Math.floor(1 / (stopDistPct * 1.5)));
    const targetBuffer = Math.max(config.isolatedLiqBufferPct / 100, 2 * stopDistPct);
    const idealLev = Math.max(1, Math.floor(1 / targetBuffer));
    // Margin feasibility: posting more buffer costs margin — rise above the
    // ideal only as far as free margin forces, never past the safety ceiling.
    const minLevForMargin =
      bal && bal.freeMarginUsd > 0
        ? Math.max(1, Math.ceil(sizeUsd / (bal.freeMarginUsd * 0.95)))
        : effectiveLev;
    openLev = Math.min(effectiveLev, stopSafeCap, Math.max(idealLev, minLevForMargin));
    isolatedLev = openLev;
  }

  // Outer clamps (unchanged semantics): agent budget, per-position cap,
  // free margin × final open leverage.
  sizeUsd = Math.min(sizeUsd, budgetLeft);
  if (Number.isFinite(perPositionCap) && (perPositionCap as number) > 0) {
    sizeUsd = Math.min(sizeUsd, perPositionCap as number);
  }
  if (bal) {
    const maxNotionalByMargin = bal.freeMarginUsd * openLev * 0.95;
    sizeUsd = Math.min(sizeUsd, maxNotionalByMargin);
  }

  // Account-level exposure guard: the WALLET (all positions — agents + the
  // user's manual trades share the cross pool) must stay ≤ N× equity. In
  // cross mode this is the number that actually governs liquidation risk.
  let walletNotionalUsd: number | null = null;
  if (equityUsd != null) {
    const walletPositions = await adapter.getAllPositions().catch(() => null);
    if (walletPositions) {
      walletNotionalUsd = walletPositions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0);
      const headroom = config.accountMaxLeverage * equityUsd - walletNotionalUsd;
      sizeUsd = Math.min(sizeUsd, Math.max(0, headroom));
    }
  }

  // User's desired max clamped by asset HL max and, when isolated, by the
  // stop-before-liquidation cap above.
  const leverage = openLev;

  const riskFields = {
    sizingMode,
    riskUsd,
    riskPerTradePct,
    liquidityTier: sizeLiquidityTier,
    stopDistPct,
    equityUsd,
    walletNotionalUsd,
    accountMaxLeverage: config.accountMaxLeverage,
    marginMode: willBeIsolated ? 'isolated' : 'cross',
    isolatedLev,
    ...(smallBudgetPump
      ? {
          smallBudgetPump: true as const,
          smallBudgetPumpFrom: smallBudgetPump.from,
          smallBudgetPumpTarget: smallBudgetPump.target,
        }
      : {}),
  };

  if (sizeUsd < MIN_ORDER_USD) {
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_margin',
      decision: {
        ...decision,
        plannedSizeUsd: sizeUsd,
        freeMarginUsd: bal?.freeMarginUsd ?? null,
        accountMode: bal?.accountMode ?? null,
        budgetLeft,
        ...riskFields,
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  // ── Book gate (item 2): can the live book absorb THIS size sanely? ───────
  // Seconds-fresh L2 pull. Skips when the spread is wide for the tier, the
  // size does not fit inside the IOC ceiling, or taking-side depth within
  // 50 bps is thin relative to the order. Applied before dry-run so shadow
  // agents mirror live behavior. A missing book never blocks (no data ≠ bad).
  const takeSide = decision.decision === 'LONG' ? 'buy' : 'sell';
  const execBook = config.bookGateEnabled
    ? await getBookSnapshot(sym, BOOK_EXEC_MAX_AGE_MS)
    : null;
  const bookGate = execBook
    ? assessBookForOpen(execBook, takeSide, sizeUsd, {
        maxSpreadBps: maxSpreadBpsFor(sym),
        minDepthMult: config.bookMinDepthMult,
        maxSlipFrac: SLIPPAGE_MAX,
      })
    : null;
  const bookFields = bookLogFields(execBook ?? args.book ?? null, bookGate);
  if (bookGate && !bookGate.ok) {
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'skipped_thin_book',
      decision: {
        ...decision,
        reason: `live book cannot absorb this order cleanly — ${bookGate.reason}`,
        plannedSizeUsd: sizeUsd,
        plannedLeverage: leverage,
        compositeScore: comp.score ?? null,
        probe: isProbe,
        ...riskFields,
        ...bookFields,
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  if (effectiveDryRun(agent)) {
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'opening_dry_run',
      decision: {
        ...decision,
        plannedSizeUsd: sizeUsd,
        plannedLeverage: leverage,
        compositeScore: comp.score ?? null,
        ...cryptoExtensionLogFields(args.data.cryptoExtension),
        probe: isProbe,
        ...riskFields,
        ...bookFields,
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  const cloid = makeAgentCloid(agent.id);
  const result = await adapter.openPosition(
    {
      symbol: sym,
      direction: decision.decision,
      sizeUsd,
      leverage,
      cloid,
    },
    { trackedNotionalUsd: args.trackedNotionalUsd },
  );

  if (!result.ok) {
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: 'opening_rejected',
      decision: { ...decision, execution: result.detail }, reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  // Record the ACTUAL fill, not the price we happened to prompt with — the
  // flip path already does this; the opening path used to persist the prompt
  // price, skewing every later P&L% off the real entry.
  const liveAfterOpen = await adapter.getPosition(sym).catch(() => null);
  const filledEntry =
    liveAfterOpen && liveAfterOpen.direction === decision.decision && liveAfterOpen.entryPrice > 0
      ? liveAfterOpen.entryPrice
      : currentPrice;
  const filledUsd =
    liveAfterOpen && liveAfterOpen.direction === decision.decision && liveAfterOpen.notionalUsd > 0
      ? liveAfterOpen.notionalUsd
      : sizeUsd;

  // Accumulate campaigns get NO on-exchange take-profit: winners are never
  // auto-clipped — profit-taking is monitor trims at extremes or the user.
  // Stored null so the monitor re-ensure pass (tracked.take_profit) and the
  // app both see "no TP" instead of a phantom target. Stop-loss stays.
  const suppressTp = mandate === 'accumulate';
  const openedAt = new Date().toISOString();
  const row = await insertPosition({
    agent_id: agent.id,
    symbol: sym,
    direction: decision.decision,
    entry_price: filledEntry,
    size_usd: filledUsd,
    leverage,
    stop_loss: decision.stop_price,
    take_profit: suppressTp ? null : decision.take_profit_target,
    conviction: decision.conviction,
    cloid_prefix: agentCloidPrefix(agent.id),
    // Original thesis for the monitors: the losing monitor's invalidation
    // check is only as good as what we remember about WHY we entered.
    thesis: {
      reasoning: decision.reasoning ?? '',
      invalidation_criteria: decision.invalidation_criteria ?? [],
      key_metrics: {
        ...(decision.key_metrics ?? {}),
        ...cryptoExtensionKeyMetrics(args.data.cryptoExtension),
      },
      add_trigger: decision.addTrigger ?? null,
      opening_size_usd: filledUsd,
      dca_count: 0,
    },
    // Opening is the first "check" timestamp — otherwise UI shows null until
    // the next hourly monitor cycle.
    last_check_at: openedAt,
  });
  args.onOpened(row);

  // Protective SL + TP on-exchange (reduce-only triggers). Accumulate: SL only.
  await adapter
    .ensureProtectiveTriggers(
      sym,
      decision.stop_price,
      suppressTp ? null : decision.take_profit_target,
    )
    .catch(() => undefined);

  await logDecision({
    agentId: agent.id, runId, symbol: sym, type: 'opening_executed',
    decision: {
      ...decision,
      sizeUsd: filledUsd,
      plannedSizeUsd: sizeUsd,
      entryPrice: filledEntry,
      leverage,
      execution: result.detail,
      ...riskFields,
      compositeScore: comp.score ?? null,
      ...cryptoExtensionLogFields(args.data.cryptoExtension),
      probe: isProbe,
      ...bookFields,
    },
    reasoning,
    provider: modelChoice.provider, model: modelChoice.model,
  });
  return 1;
}

// ── Monitoring branch (position exists) ────────────────────────────────────

async function monitorPosition(args: {
  agent: AgentRow;
  runId: string | null;
  adapter: HlAgentExecutionAdapter;
  tracked: AgentPositionRow;
  flags: ScalperFlags;
  marketData: CoinglassMarketData;
  currentPrice: number;
  priceSource: 'hl_mid' | 'bar_close';
  etfFlows: import('./data/etfFlows.js').EtfFlowsContext | null;
  hlPositioning: HlPositioningContext | null;
  whalePositions: WhalePos[] | null;
  stickyNarratives?: StickyNarrativesBoard | null;
  stickySymbolCatalysts?: StickySymbolCatalysts | null;
  horizonP: HorizonProfile;
  sessionContext: ReturnType<typeof getSessionContext>;
  /** Sum of this agent's open notionals (all symbols) — used for ADD budget. */
  agentTrackedNotionalUsd: number;
  /** Keep in-cycle tracked notional fresh after trim/add. */
  onSizeChanged?: (nextSizeUsd: number) => void;
  /** Remove this position from the in-cycle open set (exit/cut/flip close). */
  onClosed?: () => void;
  /** Register a newly opened row (flip reopen) for in-cycle budget tracking. */
  onOpened?: (row: AgentPositionRow) => void;
  healthSignals: CycleHealthSignals;
}): Promise<number> {
  const { agent, runId, adapter, tracked, flags, marketData, currentPrice } = args;
  const hs = args.healthSignals;
  const sym = tracked.symbol.toUpperCase();

  const live = await adapter.getPosition(sym);
  // Backfill missing exchange TP/SL (e.g. positions opened before TP support).
  // Also reconcile DB stop_loss to the live exchange SL when they diverge
  // (e.g. a prior cycle placed a new trigger but failed to persist due to a
  // status-parse bug — HL is source of truth for the resting trigger).
  if (live && !effectiveDryRun(agent)) {
    await adapter
      .ensureProtectiveTriggers(sym, tracked.stop_loss, tracked.take_profit)
      .catch(() => undefined);
    try {
      const tpsl = await adapter.listTpslOrders(sym);
      const liveSl = tpsl.find((o) => o.kind === 'sl')?.triggerPx;
      if (
        liveSl != null &&
        liveSl > 0 &&
        (!tracked.stop_loss || Math.abs(liveSl - tracked.stop_loss) / liveSl > STOP_REPLACE_MIN_REL)
      ) {
        await updatePosition(tracked.id, { stop_loss: liveSl });
        tracked.stop_loss = liveSl;
      }
    } catch {
      // non-fatal
    }
  }
  const unrealizedPnl = live?.unrealizedPnl ?? 0;
  // Live-aware size for budget/cap math: a pumped winner consumes headroom at
  // its mark value, never below its entry basis (see effectiveNotional).
  const effectiveSizeUsd =
    live && live.direction === tracked.direction
      ? Math.max(tracked.size_usd, live.notionalUsd)
      : tracked.size_usd;
  const pricePct = pnlPct(tracked.direction, tracked.entry_price, currentPrice);
  // Match PortfolioTabs: show ROE (price move × leverage), not raw price %.
  const lev = Math.max(1, live?.leverage || tracked.leverage || agent.config.leverage_cap || 1);
  const roePct = pricePct * lev;
  const durationMinutes = Math.max(
    0,
    Math.round((Date.now() - new Date(tracked.opened_at).getTime()) / 60_000),
  );
  const isWinning = unrealizedPnl >= 0;

  // Leverage-risk context for the prompts: the THESIS thresholds stay in
  // price-% (calibrated), but the model must see how close leverage puts the
  // position to liquidation so risk urgency can scale independently.
  const notionalUsd =
    live?.notionalUsd && live.notionalUsd > 0 ? live.notionalUsd : tracked.size_usd;
  const marginUsd = notionalUsd / lev;
  const liquidationPrice =
    live?.liquidationPx != null && live.liquidationPx > 0 ? live.liquidationPx : null;
  const liquidationDistancePct =
    liquidationPrice != null
      ? (Math.abs(currentPrice - liquidationPrice) / currentPrice) * 100
      : null;

  // ── Margin-dust sweep ──────────────────────────────────────────────────
  // After repeated trims, high-lev stubs can sit at $2–$12 margin while still
  // clearing the $15 notional min — burning hourly LLM cycles. Floor scales
  // with notional max_capital (scalper 1% / swing·investor 0.5%, ≥ MIN_ORDER)
  // and is capped by opening margin so small probes aren't flatten-on-first-trim.
  // Only sweeps reduced stubs so intentional small opens survive.
  const openingSizeUsd =
    typeof tracked.thesis?.opening_size_usd === 'number' &&
    tracked.thesis.opening_size_usd > 0
      ? tracked.thesis.opening_size_usd
      : tracked.size_usd;
  const openingMarginUsd = lev > 0 ? openingSizeUsd / lev : openingSizeUsd;
  const dustFloorUsd = dustMarginFloorUsd(
    args.horizonP.key,
    Number(agent.config.max_capital_usd) || 0,
    openingMarginUsd,
  );
  const forceActionDust = config.forceMonitorAction;
  const forceAppliesDust =
    !!forceActionDust &&
    ['hold', 'add', 'trim', 'exit', 'cut', 'flip', 'dca'].includes(forceActionDust) &&
    (!config.forceMonitorAgentId || config.forceMonitorAgentId === agent.id) &&
    (!config.forceMonitorSymbol || config.forceMonitorSymbol === sym);
  const marginDust = isMarginDustStub({
    marginUsd,
    floorUsd: dustFloorUsd,
    sizeUsd: effectiveSizeUsd,
    openingSizeUsd,
    trimCount: tracked.trim_count ?? 0,
  });
  // Young positions (< 3 monitor windows) are exempt from the sweep — probe
  // churn brake; a genuine stub burns a few LLM cycles then sweeps normally.
  const sweepAgeMs = Date.now() - new Date(tracked.opened_at).getTime();
  const sweepYoung =
    Number.isFinite(sweepAgeMs) && sweepAgeMs < 3 * args.horizonP.monitorWindowMs;
  if (marginDust && !forceAppliesDust && !sweepYoung) {
    hs.decideOk += 1;
    const dustBody = {
      action: 'exit',
      forced: true,
      marginDust: true,
      marginUsd,
      dustFloorUsd,
      sizeUsd: effectiveSizeUsd,
      openingSizeUsd,
      leverage: lev,
      trimCount: tracked.trim_count,
      horizon: args.horizonP.key,
      reason: `margin dust: $${marginUsd.toFixed(2)} < $${dustFloorUsd.toFixed(2)} floor (${args.horizonP.key === 'scalper' ? '1%' : '0.5%'} of max_capital, capped by opening margin) — closing stub`,
    };
    if (effectiveDryRun(agent)) {
      await logDecision({
        agentId: agent.id,
        runId,
        symbol: sym,
        type: 'monitor_win_dry_run',
        decision: {
          action: 'exit',
          note: 'dry run — margin dust close not executed',
          direction: tracked.direction,
          leverage: lev,
          pnlPct: roePct,
          pricePct,
          decisionBody: dustBody,
        },
      });
      return 0;
    }
    const res = await adapter.closePosition(sym, 1);
    if (res.ok) {
      hs.exitOk += 1;
      await closePositionRow({
        id: tracked.id,
        status: 'CLOSED',
        closeReason: CLOSE_REASON.MARGIN_DUST,
        closePrice: currentPrice,
        realizedPnl: unrealizedPnl,
      });
      args.onClosed?.();
      await logDecision({
        agentId: agent.id,
        runId,
        symbol: sym,
        type: isWinning ? 'monitor_win' : 'monitor_loss',
        decision: {
          action: 'exit',
          executed: true,
          direction: tracked.direction,
          leverage: lev,
          pnlPct: roePct,
          pricePct,
          decisionBody: dustBody,
        },
      });
      console.warn(
        `[margin-dust] agent=${agent.id} ${sym}: exit (margin=$${marginUsd.toFixed(2)} floor=$${dustFloorUsd.toFixed(2)})`,
      );
      return 1;
    }
    await logDecision({
      agentId: agent.id,
      runId,
      symbol: sym,
      type: isWinning ? 'monitor_win' : 'monitor_loss',
      decision: {
        action: 'exit',
        executed: false,
        direction: tracked.direction,
        leverage: lev,
        pnlPct: roePct,
        pricePct,
        decisionBody: { ...dustBody, closeFailed: true, closeDetail: res.detail },
      },
    });
    hs.exitFail += 1;
    return 0;
  }

  // ── Monitor-window throttle (investor: 4h) ─────────────────────────────
  // Worker still wakes hourly; multi-week theses shouldn't re-litigate every
  // hour. Mid-window ticks skip the LLM unless a thin risk fast-path fires.
  // First check after open always runs (checks_count === 0).
  {
    const monitorWindowMs = args.horizonP.monitorWindowMs;
    const forceActionEarly = config.forceMonitorAction;
    const forceAppliesEarly =
      !!forceActionEarly &&
      ['hold', 'add', 'trim', 'exit', 'cut', 'flip', 'dca'].includes(forceActionEarly) &&
      (!config.forceMonitorAgentId || config.forceMonitorAgentId === agent.id) &&
      (!config.forceMonitorSymbol || config.forceMonitorSymbol === sym);

    if (
      !forceAppliesEarly &&
      monitorWindowMs > COINGLASS_INTERVAL_MS &&
      (tracked.checks_count ?? 0) > 0
    ) {
      const distToStopPct =
        tracked.stop_loss && tracked.stop_loss > 0 && currentPrice > 0
          ? Math.abs((currentPrice - tracked.stop_loss) / currentPrice) * 100
          : null;
      const lastDecisions = await getRecentMonitorDecisions({
        agentId: agent.id,
        symbol: sym,
        sinceIso: tracked.opened_at,
        limit: 1,
      }).catch(() => []);
      const lastStatus =
        lastDecisions[lastDecisions.length - 1]?.thesis_status ?? null;
      const earningsUrgent = marketData.earnings?.within48h === true;
      const liqThreatened =
        liquidationDistancePct != null && liquidationDistancePct < 3;
      const nearStop = distToStopPct != null && distToStopPct < 1.5;
      const thesisDecayed =
        lastStatus === 'WEAKENED' || lastStatus === 'INVALIDATED';
      const fastPath = liqThreatened
        ? 'liq_distance'
        : earningsUrgent
          ? 'earnings_window'
          : nearStop
            ? 'near_stop'
            : thesisDecayed
              ? 'thesis_decay'
              : null;

      if (!fastPath) {
        const windowTs = currentBarWindowTs(monitorWindowMs);
        const lastCheckMs = tracked.last_check_at
          ? new Date(tracked.last_check_at).getTime()
          : 0;
        const lastWindow =
          lastCheckMs > 0 ? currentBarWindowTs(monitorWindowMs, lastCheckMs) : -1;
        if (lastWindow === windowTs) {
          hs.decideOk += 1;
          await logDecision({
            agentId: agent.id,
            runId,
            symbol: sym,
            type: 'skipped_monitor_window',
            decision: {
              reason: `monitor already ran this ${args.horizonP.key} ${Math.round(monitorWindowMs / COINGLASS_INTERVAL_MS)}h window`,
              horizon: args.horizonP.key,
              monitorWindowMs,
              windowTs,
              lastCheckAt: tracked.last_check_at,
            },
          });
          return 0;
        }
      } else {
        console.info(
          `[monitor-window] agent=${agent.id} ${sym}: early look (${fastPath}) inside ${Math.round(monitorWindowMs / COINGLASS_INTERVAL_MS)}h window`,
        );
      }
    }
  }

  // Funding: market rate (bps) + Δ since entry + HL next + accrued $ (Portfolio sign).
  const marketFundingBps = flags.fundingRateBps;
  const entryFundingBps = marketFundingBpsNearOpen(marketData, tracked.opened_at);
  const marketFundingChangeBps =
    marketFundingBps != null && entryFundingBps != null
      ? marketFundingBps - entryFundingBps
      : null;
  const hlNextFundingBps = await getHlFundingBps(sym).catch(() => null);
  // HL cumFunding.sinceOpen is positive when the position paid; flip for user P&L.
  const fundingPnlUsd =
    live?.cumFundingSinceOpen != null && Number.isFinite(live.cumFundingSinceOpen)
      ? -live.cumFundingSinceOpen
      : null;

  const shared = {
    position: {
      direction: tracked.direction,
      entry_price: tracked.entry_price,
      current_price: currentPrice,
      size: tracked.size_usd,
      leverage: lev,
      unrealized_pnl: unrealizedPnl,
      // Prompt context stays price-% (stable vs prior cycles); UI logs use ROE.
      unrealized_pnl_pct: pricePct,
      duration_minutes: durationMinutes,
      roe_pct: roePct,
      margin_usd: marginUsd,
      liquidation_price: liquidationPrice,
      liquidation_distance_pct: liquidationDistancePct,
      margin_type: live?.marginType ?? null,
    },
    updatedData: {
      spot_price: currentPrice,
      funding_rate_bps: marketFundingBps,
      funding_rate_change_bps: marketFundingChangeBps,
      hl_next_funding_bps: hlNextFundingBps,
      funding_pnl_usd: fundingPnlUsd,
      // Real last-bar liquidation $ (1h bars → genuinely "last hour"); null
      // when the series has no liq fields so prompts render N/A, not zeros.
      liquidations_1h: lastBarLiquidations(marketData),
      // Honest "since entry" DVOL delta; null when entry predates the series.
      iv_change: ivChangeSinceOpen(marketData, tracked.opened_at),
      volume_spike: (flags.volumeZScore ?? 0) >= 2,
      flowRatio: flags.flowRatio3 ?? undefined,
      oiDeltaPct: flags.oiDeltaPct3 ?? undefined,
      premiumBps: flags.premiumBps ?? undefined,
      ivDelta: flags.ivDeltaPts ?? undefined,
      cvdNet24Usd: flags.cvdNet24Usd,
      spotCvdNet24Usd: flags.spotCvdNet24Usd,
      cvdDivergence: flags.cvdDivergence,
      regime: {
        volatilityState: flags.volatilityState,
        liquidityState: flags.liquidityState,
        trendConsistency: flags.trendConsistency,
        chopRisk: flags.chopRisk,
        rangeCompression: flags.rangeCompression,
      },
    },
    positionHistory: {
      checks_count: tracked.checks_count,
      last_check_time: tracked.last_check_at ?? tracked.opened_at,
      has_trimmed: tracked.trim_count > 0,
      trim_count: tracked.trim_count,
      dca_count: dcaCountOf(tracked),
      // Last monitor decisions since this position opened — powers the
      // prompts' P&L-momentum rules ("dropped >1.5% since last check").
      // pnl_pct is price-% to stay on the same basis as unrealized_pnl_pct.
      previous_decisions: await getRecentMonitorDecisions({
        agentId: agent.id,
        symbol: sym,
        sinceIso: tracked.opened_at,
        limit: 3,
      }).catch(() => []),
    },
    etfFlows: args.etfFlows,
    hlPositioning: args.hlPositioning,
    whalePositions: args.whalePositions,
    stickyNarratives: args.stickyNarratives ?? null,
    stickySymbolCatalysts: args.stickySymbolCatalysts ?? null,
    ema: marketData.ema ?? null,
    earnings: marketData.earnings ?? null,
    equityOptions: marketData.equityOptions ?? null,
    equityDaily: marketData.equityDaily ?? null,
    cryptoExtension: isCryptoAsset(sym) ? marketData.cryptoExtension ?? null : null,
    horizon: args.horizonP.key,
    direction: normalizeDirection(agent.config.direction),
    mandate: normalizeMandate(agent.config.mandate),
    sessionContext: args.sessionContext,
  };

  const thesis = tracked.thesis ?? null;
  const original = {
    conviction: tracked.conviction ?? 50,
    stop_loss: tracked.stop_loss ?? 0,
    take_profit: tracked.take_profit ?? 0,
    reasoning: thesis?.reasoning ?? '',
    invalidation_criteria: thesis?.invalidation_criteria ?? [],
    add_trigger: thesis?.add_trigger ?? null,
  };

  const modelChoice = isWinning
    ? agent.config.models.monitor_win ?? agent.config.models.opening
    : agent.config.models.monitor_loss ?? agent.config.models.opening;
  const modelKey = resolveModelKey(agent, modelChoice);

  let action: string;
  let trimPct = 0.25;
  let rawDecision: unknown;
  let reasoning: unknown;

  const forceAction = config.forceMonitorAction;
  const forceApplies =
    !!forceAction &&
    ['hold', 'add', 'trim', 'exit', 'cut', 'flip', 'dca'].includes(forceAction) &&
    (!config.forceMonitorAgentId || config.forceMonitorAgentId === agent.id) &&
    (!config.forceMonitorSymbol || config.forceMonitorSymbol === sym);

  if (forceApplies) {
    action = forceAction!;
    trimPct = Math.min(0.5, Math.max(0.1, config.forceTrimPct || 0.25));
    const flipSide =
      action === 'flip' ? resolveFlipSide(tracked.direction, {}) : undefined;
    rawDecision = {
      action: forceAction,
      forced: true,
      note: `FORCE_MONITOR_ACTION=${forceAction}`,
      trimPct,
      addSize: Math.min(0.5, Math.max(0.1, config.forceAddSize || 0.25)),
      dcaSize: Math.min(0.33, Math.max(0.15, config.forceAddSize || 0.25)),
      thesis_status: action === 'dca' ? 'INTACT' : undefined,
      cutTriggers:
        action === 'dca'
          ? { oiAgainst: false, premiumFlip: false, oppositeFlow: false }
          : undefined,
      ...(flipSide ? { flipSide } : {}),
    };
    reasoning = {
      forced: true,
      forceMonitorAction: forceAction,
      agentId: agent.id,
      symbol: sym,
    };
    console.warn(`[force] agent=${agent.id} ${sym} action=${action}`);
  } else if (isWinning) {
    const prompt = buildWinningMonitorPrompt({
      asset: sym,
      ...shared,
      original,
    });
    const llm = await callModel({ choice: modelChoice, apiKey: modelKey, prompt });
    const out = validateWinningMonitorResponse(parseJsonReply(llm.content));
    action = out.action;
    rawDecision = out;
    reasoning = buildStoredLlmReasoning({
      model: llm.model,
      latencyMs: llm.latencyMs,
      prompt,
    });

    // ── Winning thesis-decay enforcement ───────────────────────────────
    // Prompt alone left BTC-style WEAKENED holds while green (hard trim
    // checklists unmet). Worker upgrades idle hold/add:
    //   INVALIDATED → exit (bank; thesis driver gone — live INTC pattern)
    //   WEAKENED or material conviction decay → trim (if trims remain)
    // Decay = conviction ≤ open−25, or < 40 for positions that OPENED ≥ 40.
    // Probes open at sub-40 conviction by definition — the absolute clause
    // used to trim every profitable probe at its first check (live scalper
    // churn: 21/23 closes were dust sweeps ~1.5h after open), so it only
    // applies when the position ever had ≥ 40 to decay from.
    if (action === 'hold' || action === 'add') {
      const status = out.thesis_status;
      const tc = out.thesis_conviction;
      const openConv =
        typeof tracked.conviction === 'number' && tracked.conviction > 0
          ? tracked.conviction
          : typeof original.conviction === 'number' && original.conviction > 0
            ? original.conviction
            : null;
      const decayed =
        typeof tc === 'number' &&
        ((openConv != null && tc <= openConv - 25) ||
          (tc < 40 && (openConv == null || openConv >= 40)));
      const weakened = status === 'WEAKENED' || decayed;
      const invalidated = status === 'INVALIDATED';
      if (invalidated) {
        const from = action;
        rawDecision = {
          ...out,
          action: 'exit',
          upgradedFrom: from,
          upgradeReason: `winning thesis INVALIDATED — bank gains (was ${from})`,
        };
        console.warn(
          `[thesis-decay] agent=${agent.id} ${sym}: ${from} → exit (INVALIDATED, conviction=${tc ?? 'n/a'})`,
        );
        action = 'exit';
      } else if (weakened && tracked.trim_count < MAX_TRIMS_PER_POSITION) {
        const from = action;
        trimPct = 0.25;
        rawDecision = {
          ...out,
          action: 'trim',
          trimPct,
          upgradedFrom: from,
          upgradeReason: `winning thesis ${status ?? 'n/a'} / conviction ${tc ?? 'n/a'} (open ${openConv ?? 'n/a'}) — force trim (was ${from})`,
        };
        console.warn(
          `[thesis-decay] agent=${agent.id} ${sym}: ${from} → trim (status=${status}, conviction=${tc ?? 'n/a'}/${openConv ?? 'n/a'})`,
        );
        action = 'trim';
      }
    }
  } else {
    const prompt = buildLosingMonitorPrompt({
      asset: sym,
      ...shared,
      position: {
        ...shared.position,
        distance_to_stop: tracked.stop_loss
          ? Math.abs(((currentPrice - tracked.stop_loss) / currentPrice) * 100)
          : 0,
      },
      original,
      updatedData: {
        ...shared.updatedData,
        // Real premium drift since entry (bps); null when entry bar unknown.
        basis_change_bps: (() => {
          const now = flags.premiumBps;
          const atEntry = premiumBpsNearOpen(marketData, tracked.opened_at);
          return now != null && atEntry != null ? now - atEntry : null;
        })(),
        invalidation_status: [],
      },
    });
    const llm = await callModel({ choice: modelChoice, apiKey: modelKey, prompt });
    const out = validateLosingMonitorResponse(parseJsonReply(llm.content));
    action = out.action;
    trimPct = out.trimPct ?? 0.25;
    rawDecision = out;
    reasoning = buildStoredLlmReasoning({
      model: llm.model,
      latencyMs: llm.latencyMs,
      prompt,
    });

    // HIP-3 equities/metals: venue OI is not a thesis/cut signal (thin book).
    // Force oiAgainst false so models can't use it to satisfy 2/3 cuts.
    const hip3Listed =
      assetClassOf(sym) === 'equity' || isMetalsOptionsAsset(sym);
    if (hip3Listed && out.cutTriggers) {
      out.cutTriggers = { ...out.cutTriggers, oiAgainst: false };
      rawDecision = out;
    }

    // ── Thesis-persistence enforcement (swing/investor) ──────────────────
    // Prompt text alone doesn't stop the "would I enter fresh now?" reframe
    // (observed live: trims/cuts whose own reason says "thesis not fully
    // invalidated"). For patient horizons the worker enforces evidence:
    //   cut/flip  → require thesis INVALIDATED or ≥2 cut triggers, else trim
    //   trim      → require thesis ≠ INTACT (investor also ≥1 trigger), else hold
    // HIP-3: only premiumFlip + oppositeFlow count (oiAgainst ignored).
    // Real risk (HL stop/TP triggers, liquidation guards) is untouched.
    if (args.horizonP.key !== 'scalper') {
      const t = out.cutTriggers ?? { oiAgainst: false, premiumFlip: false, oppositeFlow: false };
      const trigCount = hip3Listed
        ? [t.premiumFlip, t.oppositeFlow].filter(Boolean).length
        : [t.oiAgainst, t.premiumFlip, t.oppositeFlow].filter(Boolean).length;
      const needForCut = 2;
      const status = out.thesis_status;
      let downgradeTo: 'trim' | 'hold' | null = null;
      if ((action === 'cut' || action === 'flip') && status !== 'INVALIDATED' && trigCount < needForCut) {
        downgradeTo = 'trim';
      } else if (
        action === 'trim' &&
        (status === 'INTACT' || (args.horizonP.key === 'investor' && trigCount < 1))
      ) {
        downgradeTo = 'hold';
      }
      if (downgradeTo) {
        rawDecision = {
          ...out,
          action: downgradeTo,
          downgradedFrom: action,
          downgradeReason: `${args.horizonP.key} horizon: ${action} requires INVALIDATED thesis or enough cut triggers (status=${status}, triggers=${trigCount}/${hip3Listed ? 2 : 3}${hip3Listed ? ', hip3-no-OI' : ''})`,
        };
        console.warn(
          `[thesis-guard] agent=${agent.id} ${sym}: ${action} → ${downgradeTo} (status=${status}, triggers=${trigCount}/${hip3Listed ? 2 : 3}, horizon=${args.horizonP.key})`,
        );
        action = downgradeTo;
        if (downgradeTo === 'trim') trimPct = Math.min(trimPct, 0.33);
      }
    }
  }

  // Direction mandate: a flip into a disallowed side becomes a cut — the
  // agent may exit but never hold the forbidden direction.
  if (action === 'flip') {
    const agentDirection = normalizeDirection(agent.config.direction);
    const flipTarget = resolveFlipSide(tracked.direction, rawDecision ?? {});
    if (!directionAllows(agentDirection, flipTarget)) {
      const prev = typeof rawDecision === 'object' && rawDecision ? rawDecision : {};
      rawDecision = {
        ...prev,
        action: 'cut',
        downgradedFrom: 'flip',
        downgradeReason: `agent is ${agentDirection} — flip to ${flipTarget} not allowed`,
      };
      console.warn(
        `[mandate] agent=${agent.id} ${sym}: flip → cut (${agentDirection}, target=${flipTarget})`,
      );
      action = 'cut';
    }
  }

  // Max-trim cap: LLM often re-picks trim after 3/3 (live BTC overnight:
  // hourly max_trims no-ops burning tokens). Downgrade to hold so the
  // logged action matches what runs; CUT/EXIT still available if thesis dies.
  if (action === 'trim' && tracked.trim_count >= MAX_TRIMS_PER_POSITION) {
    const prev = typeof rawDecision === 'object' && rawDecision ? rawDecision : {};
    rawDecision = {
      ...prev,
      action: 'hold',
      downgradedFrom: 'trim',
      downgradeReason: `max_trims (${tracked.trim_count}/${MAX_TRIMS_PER_POSITION}) — further trim is a no-op`,
    };
    console.warn(
      `[max-trims] agent=${agent.id} ${sym}: trim → hold (${tracked.trim_count}/${MAX_TRIMS_PER_POSITION})`,
    );
    action = 'hold';
  }

  // LLM decide succeeded (force path or model). Exit HL failures are tracked
  // separately via exitFail — don't treat a good decide as an outage.
  hs.decideOk += 1;

  await updatePosition(tracked.id, {
    checks_count: tracked.checks_count + 1,
    last_check_at: new Date().toISOString(),
  });

  const decisionType = isWinning ? 'monitor_win' : 'monitor_loss';

  if (effectiveDryRun(agent)) {
    await logDecision({
      agentId: agent.id, runId, symbol: sym, type: `${decisionType}_dry_run`,
      decision: {
        action,
        note: 'dry run — not executed',
        direction: tracked.direction,
        leverage: lev,
        pnlPct: roePct,
        pricePct,
        roePct,
        liquidationDistancePct,
        priceSource: args.priceSource,
        decisionBody: rawDecision,
        ...cryptoExtensionLogFields(marketData.cryptoExtension),
      },
      reasoning,
      provider: modelChoice.provider, model: modelChoice.model,
    });
    return 0;
  }

  let executed = 0;
  let flipTo: 'LONG' | 'SHORT' | null = null;
  let stopUpdate: {
    from: number | null;
    to: number;
    intent: string;
    ok: boolean;
    detail?: string;
  } | null = null;

  switch (action) {
    case 'exit':
    case 'cut': {
      // closePosition already retries 429/transient HL errors and re-checks
      // flatness — no second LLM call. On persistent failure we leave the
      // row OPEN so the next cycle can try again (still one LLM then).
      const res = await adapter.closePosition(sym, 1);
      if (res.ok) {
        hs.exitOk += 1;
        await closePositionRow({
          id: tracked.id,
          status: 'CLOSED',
          closeReason: action === 'cut' ? CLOSE_REASON.CUT : CLOSE_REASON.EXIT,
          closePrice: currentPrice,
          realizedPnl: unrealizedPnl,
        });
        args.onClosed?.();
        executed = 1;
      } else {
        // Adapter already retried transient HL errors in-cycle.
        hs.exitFail += 1;
        rawDecision = {
          ...(rawDecision as object),
          closeFailed: true,
          closeDetail: res.detail,
        };
      }
      break;
    }
    case 'flip': {
      // Same-cycle reverse: reduce-only close, then open opposite. HL has no
      // native flip action — a single 2× opposite order can flip, but two
      // steps keep DB + TP/SL accounting clear and avoid partial-fill limbo.
      flipTo = resolveFlipSide(tracked.direction, rawDecision);
      const fromDir = tracked.direction;
      const sizeUsd = Math.max(
        MIN_ORDER_USD,
        live?.notionalUsd && live.notionalUsd > 0 ? live.notionalUsd : tracked.size_usd,
      );
      const leverage = await effectiveOpenLeverage(agent.config.leverage_cap, sym);

      const closeRes = await adapter.closePosition(sym, 1);
      if (!closeRes.ok) {
        hs.exitFail += 1;
        rawDecision = {
          ...(rawDecision as object),
          flipFailed: true,
          flipStage: 'close',
          flipDetail: closeRes.detail,
          fromDirection: fromDir,
          toDirection: flipTo,
        };
        break;
      }

      hs.exitOk += 1;
      await closePositionRow({
        id: tracked.id,
        status: 'CLOSED',
        closeReason: CLOSE_REASON.FLIP,
        closePrice: currentPrice,
        realizedPnl: unrealizedPnl,
      });
      args.onClosed?.();

      const notionalAfterClose = Math.max(
        0,
        args.agentTrackedNotionalUsd - effectiveSizeUsd,
      );
      let openUsd = sizeUsd;
      const notionalBudget = agentRowNotionalBudgetUsd(agent);
      const budgetLeft = notionalBudget - notionalAfterClose;
      openUsd = Math.min(openUsd, Math.max(0, budgetLeft));
      const perPositionCap = agent.config.max_position_usd;
      if (Number.isFinite(perPositionCap) && (perPositionCap as number) > 0) {
        openUsd = Math.min(openUsd, perPositionCap as number);
      }
      const bal = await adapter.getBalance().catch(() => null);
      if (bal) {
        openUsd = Math.min(openUsd, bal.freeMarginUsd * leverage * 0.95);
      }

      if (openUsd < MIN_ORDER_USD) {
        rawDecision = {
          ...(rawDecision as object),
          flipPartial: true,
          flipStage: 'open_skipped',
          fromDirection: fromDir,
          toDirection: flipTo,
          plannedOpenUsd: openUsd,
          budgetLeft,
          freeMarginUsd: bal?.freeMarginUsd ?? null,
          note: 'closed for flip but reopen below min notional / margin',
        };
        executed = 1;
        break;
      }

      const openRes = await adapter
        .openPosition(
          {
            symbol: sym,
            direction: flipTo,
            sizeUsd: openUsd,
            leverage,
            cloid: makeAgentCloid(agent.id),
          },
          { trackedNotionalUsd: notionalAfterClose },
        )
        .catch((err) => ({ ok: false as const, detail: String(err) }));

      if (!openRes.ok) {
        rawDecision = {
          ...(rawDecision as object),
          flipPartial: true,
          flipStage: 'open_failed',
          fromDirection: fromDir,
          toDirection: flipTo,
          plannedOpenUsd: openUsd,
          flipDetail: openRes.detail,
          note: 'closed for flip but opposite open failed — flat until next cycle',
        };
        executed = 1;
        break;
      }

      const liveAfter = await adapter.getPosition(sym).catch(() => null);
      const entry =
        liveAfter && liveAfter.direction === flipTo
          ? liveAfter.entryPrice
          : currentPrice;
      const filledUsd =
        liveAfter && liveAfter.direction === flipTo && liveAfter.notionalUsd > 0
          ? liveAfter.notionalUsd
          : openUsd;
      const { stop, takeProfit } = flipProtectiveLevels(flipTo, entry, tracked);
      const openedAt = new Date().toISOString();
      const row = await insertPosition({
        agent_id: agent.id,
        symbol: sym,
        direction: flipTo,
        entry_price: entry,
        size_usd: filledUsd,
        leverage,
        stop_loss: stop,
        take_profit: takeProfit,
        conviction: tracked.conviction,
        cloid_prefix: agentCloidPrefix(agent.id),
        last_check_at: openedAt,
        thesis: {
          reasoning: tracked.thesis?.reasoning ?? '',
          invalidation_criteria: tracked.thesis?.invalidation_criteria ?? [],
          key_metrics: tracked.thesis?.key_metrics ?? null,
          add_trigger: tracked.thesis?.add_trigger ?? null,
          opening_size_usd: filledUsd,
          dca_count: 0,
        },
      });
      args.onOpened?.(row);
      await adapter
        .ensureProtectiveTriggers(sym, stop, takeProfit)
        .catch(() => undefined);

      rawDecision = {
        ...(rawDecision as object),
        flipSide: flipTo,
        fromDirection: fromDir,
        toDirection: flipTo,
        flipOpenedUsd: filledUsd,
        flipEntry: entry,
        flipStop: stop,
        flipTakeProfit: takeProfit,
        closeDetail: closeRes.detail,
        openDetail: openRes.detail,
      };
      executed = 1;
      break;
    }
    case 'trim': {
      if (tracked.trim_count >= MAX_TRIMS_PER_POSITION) {
        rawDecision = {
          ...(rawDecision as object),
          trimSkipped: true,
          reason: 'max_trims',
        };
        break;
      }
      const pctToTrim = Math.min(0.5, Math.max(0.1, trimPct));
      const trimUsd = tracked.size_usd * pctToTrim;
      const remainderUsd = tracked.size_usd - trimUsd;
      const remainderMarginUsd = remainderUsd / lev;
      // Escalate to full close when the slice/leftover notional would be dust
      // OR leftover margin would sit under the budget-scaled margin floor.
      const remainderIsMarginDust = isMarginDustStub({
        marginUsd: remainderMarginUsd,
        floorUsd: dustFloorUsd,
        sizeUsd: remainderUsd,
        openingSizeUsd,
        trimCount: (tracked.trim_count ?? 0) + 1,
      });
      // Young-position guard: probes are small enough that ANY trim leaves a
      // dust stub, so trim→full-close escalation was recycling every probe at
      // its first monitor check (~1.5h lifetimes, 21/23 scalper closes were
      // dust). If the position is younger than 3 monitor windows, skip the
      // trim and HOLD — the on-exchange stop/TP still protect it, and cut/exit
      // paths are untouched for genuinely broken theses.
      const positionAgeMs = Date.now() - new Date(tracked.opened_at).getTime();
      const youngPosition =
        Number.isFinite(positionAgeMs) &&
        positionAgeMs < 3 * args.horizonP.monitorWindowMs;
      if (
        youngPosition &&
        (trimUsd < MIN_ORDER_USD ||
          remainderUsd < MIN_ORDER_USD ||
          remainderIsMarginDust)
      ) {
        action = 'hold';
        {
          const prev = rawDecision as Record<string, unknown>;
          rawDecision = {
            ...prev,
            action: 'hold',
            llmAction: 'trim',
            trimSkippedYoung: true,
            positionAgeMs: Math.round(positionAgeMs),
            plannedTrimUsd: trimUsd,
            remainderUsd,
            remainderMarginUsd,
            dustFloorUsd,
            note: 'trim would escalate to a dust close on a young position — holding instead (stop/TP unchanged)',
            // Keep the model's thesis summary. Size/dust lives in `note`.
          };
        }
        console.warn(
          `[trim-young] agent=${agent.id} ${sym}: trim → hold (age=${(positionAgeMs / 3600000).toFixed(1)}h, remainder margin $${remainderMarginUsd.toFixed(2)} < floor $${dustFloorUsd.toFixed(2)})`,
        );
        break;
      }
      if (
        trimUsd < MIN_ORDER_USD ||
        remainderUsd < MIN_ORDER_USD ||
        remainderIsMarginDust
      ) {
        // Position too small to leave a meaningful probe — full close.
        // Override `action` so the feed shows CUT (not TRIM) for what ran.
        const res = await adapter.closePosition(sym, 1);
        if (res.ok) {
          await closePositionRow({
            id: tracked.id,
            status: 'CLOSED',
            closeReason: remainderIsMarginDust
              ? CLOSE_REASON.MARGIN_DUST
              : CLOSE_REASON.TRIM_ESCALATED,
            closePrice: currentPrice,
            realizedPnl: unrealizedPnl,
          });
          args.onClosed?.();
          executed = 1;
          action = 'cut';
          {
            const prev = rawDecision as Record<string, unknown>;
            const prevSummary =
              typeof prev.summary === 'string' && prev.summary.trim()
                ? prev.summary.trim()
                : undefined;
            // Keep the model's thesis summary. Headline already shows CUT;
            // size/dust lives in `note` so it does not overwrite the thesis.
            rawDecision = {
              ...prev,
              llmAction: 'trim',
              llmSummary: prevSummary,
              trimEscalatedToClose: true,
              marginDust: remainderIsMarginDust,
              plannedTrimUsd: trimUsd,
              remainderUsd,
              remainderMarginUsd,
              dustFloorUsd,
              minOrderUsd: MIN_ORDER_USD,
              note: remainderIsMarginDust
                ? 'trim would leave margin-dust stub — closed full position'
                : 'trim size below minimum — closed full position',
            };
          }
        } else {
          rawDecision = {
            ...(rawDecision as object),
            llmAction: 'trim',
            trimFailed: true,
            trimEscalatedToClose: true,
            trimDetail: res.detail,
            plannedTrimUsd: trimUsd,
            remainderUsd,
            remainderMarginUsd,
            dustFloorUsd,
            minOrderUsd: MIN_ORDER_USD,
          };
        }
        break;
      }
      const res = await adapter.trimPosition(sym, pctToTrim);
      if (res.ok) {
        const nextSize = tracked.size_usd * (1 - pctToTrim);
        await updatePosition(tracked.id, {
          trim_count: tracked.trim_count + 1,
          size_usd: nextSize,
        });
        args.onSizeChanged?.(nextSize);
        executed = 1;
      } else {
        rawDecision = {
          ...(rawDecision as object),
          trimFailed: true,
          trimDetail: res.detail,
          plannedTrimUsd: trimUsd,
        };
      }
      break;
    }
    case 'add':
    case 'dca': {
      const isDca = action === 'dca';
      if (isDca) {
        const body = rawDecision as {
          thesis_status?: string;
          cutTriggers?: {
            oiAgainst?: boolean;
            premiumFlip?: boolean;
            oppositeFlow?: boolean;
          };
        };
        const cuts = body.cutTriggers ?? {};
        const anyCut =
          !!cuts.oiAgainst || !!cuts.premiumFlip || !!cuts.oppositeFlow;
        const chopOk =
          flags.chopRisk === true || flags.volatilityState === 'low';
        const distToStopPct =
          tracked.stop_loss && tracked.stop_loss > 0 && currentPrice > 0
            ? Math.abs((currentPrice - tracked.stop_loss) / currentPrice) * 100
            : null;
        const lossPct = Math.abs(pricePct);
        const hm = args.horizonP.monitorThresholdMult;
        const lossRoomOk =
          distToStopPct != null && distToStopPct > 0
            ? lossPct < 0.5 * distToStopPct
            : lossPct < 2 * hm;
        const dcaN = dcaCountOf(tracked);
        let dcaBlock: string | null = null;
        if (body.thesis_status !== 'INTACT') dcaBlock = 'thesis_not_intact';
        else if (anyCut) dcaBlock = 'cut_triggers';
        else if (!chopOk) dcaBlock = 'no_chop_context';
        else if (!lossRoomOk) dcaBlock = 'loss_too_deep';
        else if (dcaN >= MAX_DCAS_PER_POSITION) dcaBlock = 'max_dcas';
        if (dcaBlock) {
          rawDecision = {
            ...(rawDecision as object),
            dcaSkipped: true,
            reason: dcaBlock,
            dcaCount: dcaN,
            lossPct,
            distToStopPct,
          };
          break;
        }
      }

      const sizeFrac = isDca
        ? Math.min(
            0.33,
            Math.max(0.15, (rawDecision as { dcaSize?: number }).dcaSize ?? 0.25),
          )
        : Math.min(0.5, (rawDecision as { addSize?: number }).addSize ?? 0);
      if (sizeFrac <= 0) break;

      // Headroom first — small test positions often size to a % that lands
      // under HL's ~$15 min notional; if margin/budget allow, floor up to min.
      const budgetLeft = Math.max(
        0,
        agentRowNotionalBudgetUsd(agent) - args.agentTrackedNotionalUsd,
      );
      let maxAllowed = budgetLeft;
      const perPositionCap = agent.config.max_position_usd;
      if (Number.isFinite(perPositionCap) && (perPositionCap as number) > 0) {
        // Live-aware: a position pumped past its per-position cap gets NO add
        // headroom (instead of phantom room from its smaller entry basis).
        maxAllowed = Math.min(
          maxAllowed,
          Math.max(0, (perPositionCap as number) - effectiveSizeUsd),
        );
      }
      const bal = await adapter.getBalance().catch(() => null);
      const openLev = await effectiveOpenLeverage(
        Math.max(1, tracked.leverage || agent.config.leverage_cap),
        sym,
      );
      if (bal) {
        maxAllowed = Math.min(maxAllowed, bal.freeMarginUsd * openLev * 0.95);
      }
      // Account-level exposure guard (same rule as opens): the wallet's total
      // notional must stay ≤ N× equity — adds must not stack past it.
      if (bal && Number.isFinite(bal.accountValueUsd) && bal.accountValueUsd > 0) {
        const walletPositions = await adapter.getAllPositions().catch(() => null);
        if (walletPositions) {
          const walletNotional = walletPositions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0);
          maxAllowed = Math.min(
            maxAllowed,
            Math.max(0, config.accountMaxLeverage * bal.accountValueUsd - walletNotional),
          );
        }
      }

      const baseUsd = pyramidBaseUsd(tracked);
      let addUsd = Math.min(baseUsd * sizeFrac, maxAllowed);
      let addFlooredToMin = false;
      if (addUsd > 0 && addUsd < MIN_ORDER_USD && maxAllowed >= MIN_ORDER_USD) {
        addUsd = MIN_ORDER_USD;
        addFlooredToMin = true;
      }
      if (addUsd < MIN_ORDER_USD) {
        rawDecision = {
          ...(rawDecision as object),
          ...(isDca ? { dcaSkipped: true } : { addSkipped: true }),
          plannedAddUsd: addUsd,
          pyramidBaseUsd: baseUsd,
          maxAllowedUsd: maxAllowed,
          budgetLeft,
          freeMarginUsd: bal?.freeMarginUsd ?? null,
          minOrderUsd: MIN_ORDER_USD,
        };
        break;
      }
      const res = await adapter.openPosition(
        {
          symbol: sym,
          direction: tracked.direction,
          sizeUsd: addUsd,
          leverage: tracked.leverage,
          cloid: makeAgentCloid(agent.id),
        },
        { trackedNotionalUsd: args.agentTrackedNotionalUsd },
      ).catch((err) => ({ ok: false as const, detail: String(err) }));
      if (res.ok) {
        const nextSize = tracked.size_usd + addUsd;
        const thesisPatch = isDca
          ? {
              ...(tracked.thesis ?? {}),
              opening_size_usd:
                tracked.thesis?.opening_size_usd ?? pyramidBaseUsd(tracked),
              dca_count: dcaCountOf(tracked) + 1,
            }
          : tracked.thesis;
        await updatePosition(tracked.id, {
          size_usd: nextSize,
          ...(isDca ? { thesis: thesisPatch } : {}),
        });
        if (isDca && thesisPatch) {
          tracked.thesis = thesisPatch;
        }
        tracked.size_usd = nextSize;
        args.onSizeChanged?.(nextSize);
        executed = 1;
        rawDecision = {
          ...(rawDecision as object),
          plannedAddUsd: addUsd,
          pyramidBaseUsd: baseUsd,
          ...(addFlooredToMin
            ? {
                addFlooredToMin: true,
                note: `${isDca ? 'dca' : 'add'} % was below min notional — floored to MIN_ORDER_USD`,
              }
            : {}),
        };
      }
      break;
    }
    default:
      break; // hold
  }

  // Stop management: apply newStop / stopManagement when the position is still
  // open. Never runs after a successful full close / flip. Never loosens; skips
  // if the planned price is unchanged or would fire immediately.
  if (action !== 'exit' && action !== 'cut' && action !== 'flip') {
    const intent = resolveStopIntent(rawDecision, isWinning);
    const planned = planStopUpdate({
      intent,
      direction: tracked.direction,
      entry: tracked.entry_price,
      currentPrice,
      currentStop: tracked.stop_loss,
    });
    if (planned) {
      const res = await adapter
        .replaceStopLoss(sym, planned.nextStop)
        .catch((err) => ({ ok: false as const, detail: String(err) }));
      stopUpdate = {
        from: tracked.stop_loss,
        to: planned.nextStop,
        intent: planned.reason,
        ok: res.ok,
        detail: res.ok ? undefined : res.detail,
      };
      if (res.ok) {
        await updatePosition(tracked.id, { stop_loss: planned.nextStop });
        tracked.stop_loss = planned.nextStop;
        executed = Math.max(executed, 1);
      }
    }
  }

  const flipFullyOpened =
    action === 'flip' &&
    flipTo != null &&
    executed > 0 &&
    !(rawDecision as { flipPartial?: boolean; flipFailed?: boolean }).flipPartial &&
    !(rawDecision as { flipPartial?: boolean; flipFailed?: boolean }).flipFailed;
  const logDirection = flipFullyOpened ? flipTo! : tracked.direction;

  await logDecision({
    agentId: agent.id, runId, symbol: sym, type: decisionType,
    decision: {
      action,
      executed: executed > 0,
      direction: logDirection,
      ...(action === 'flip'
        ? {
            fromDirection: tracked.direction,
            toDirection: flipTo,
            flipFullyOpened,
          }
        : {}),
      leverage: lev,
      // ROE — same basis as PortfolioTabs (% of margin). pricePct kept for debug.
      pnlPct: roePct,
      pricePct,
      roePct,
      liquidationDistancePct,
      priceSource: args.priceSource,
      decisionBody: rawDecision,
      ...cryptoExtensionLogFields(marketData.cryptoExtension),
      ...(stopUpdate ? { stopUpdate } : {}),
    },
    reasoning,
    provider: modelChoice.provider, model: modelChoice.model,
  });
  return executed;
}
