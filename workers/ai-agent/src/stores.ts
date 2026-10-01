/** Supabase-backed stores (replace the old Redis position-manager-kv.ts). */
import { getSupabase } from './lib/supabase.js';
import type { AgentPositionRow } from './types.js';

export async function getOpenPositions(agentId: string): Promise<AgentPositionRow[]> {
  const { data, error } = await getSupabase()
    .from('ai_agent_positions')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', 'OPEN');
  if (error) throw new Error(`getOpenPositions: ${error.message}`);
  return (data ?? []) as AgentPositionRow[];
}

export async function insertPosition(
  row: Omit<Partial<AgentPositionRow>, 'id'> & {
    agent_id: string;
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entry_price: number;
    size_usd: number;
    leverage: number;
  },
): Promise<AgentPositionRow> {
  const { data, error } = await getSupabase()
    .from('ai_agent_positions')
    .insert(row)
    .select('*')
    .single();
  if (error) throw new Error(`insertPosition: ${error.message}`);
  return data as AgentPositionRow;
}

export async function updatePosition(
  id: string,
  patch: Partial<AgentPositionRow>,
): Promise<void> {
  const { error } = await getSupabase().from('ai_agent_positions').update(patch).eq('id', id);
  if (error) throw new Error(`updatePosition: ${error.message}`);
}

export async function closePositionRow(args: {
  id: string;
  status: 'CLOSED' | 'CLOSED_BY_USER';
  closeReason: string;
  closePrice?: number | null;
  realizedPnl?: number | null;
}): Promise<void> {
  await updatePosition(args.id, {
    status: args.status,
    close_reason: args.closeReason,
    close_price: args.closePrice ?? null,
    realized_pnl: args.realizedPnl ?? null,
    closed_at: new Date().toISOString(),
  });
}

/** Close reasons that arm the re-open cooldown (loss-flavored exits). */
const LOSS_CLOSE_REASONS = new Set([
  'trim_escalated',
  'stop_fill',
  'cut',
  'liquidated',
]);

export interface LastSymbolClose {
  closedAt: string;
  closeReason: string | null;
  direction: 'LONG' | 'SHORT' | null;
  entryPrice: number | null;
  closePrice: number | null;
  realizedPnl: number | null;
  sizeUsd: number | null;
}

export function isLossyClose(close: LastSymbolClose): boolean {
  const pnl = close.realizedPnl;
  return (
    (close.closeReason != null && LOSS_CLOSE_REASONS.has(close.closeReason)) ||
    (pnl != null && Number.isFinite(pnl) && pnl < 0)
  );
}

/**
 * Most recent closed position for agent+symbol (any outcome). Powers the
 * opening-prompt LAST CLOSE card and the loss-close churn brake.
 */
export async function getLastSymbolClose(args: {
  agentId: string;
  symbol: string;
}): Promise<LastSymbolClose | null> {
  const { data, error } = await getSupabase()
    .from('ai_agent_positions')
    .select(
      'closed_at, close_reason, realized_pnl, direction, entry_price, close_price, size_usd',
    )
    .eq('agent_id', args.agentId)
    .eq('symbol', args.symbol.toUpperCase())
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastSymbolClose: ${error.message}`);
  if (!data?.closed_at) return null;
  const dir = data.direction === 'LONG' || data.direction === 'SHORT' ? data.direction : null;
  const num = (v: unknown): number | null => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    closedAt: data.closed_at as string,
    closeReason: (data.close_reason as string | null) ?? null,
    direction: dir,
    entryPrice: num(data.entry_price),
    closePrice: num(data.close_price),
    realizedPnl: num(data.realized_pnl),
    sizeUsd: num(data.size_usd),
  };
}

/**
 * Most recent loss-close for agent+symbol, or null. Powers the churn brake:
 * after a loss-flavored close (or any close with realized_pnl < 0), fresh
 * opens on that symbol wait out the horizon's cooldown instead of re-entering
 * on the very next bar (observed live: TSLA open→trim_escalated→re-open
 * every 2h, pure fee bleed).
 */
export async function getLastLossClose(args: {
  agentId: string;
  symbol: string;
}): Promise<{ closedAt: string; closeReason: string | null } | null> {
  const last = await getLastSymbolClose(args);
  if (!last || !isLossyClose(last)) return null;
  return { closedAt: last.closedAt, closeReason: last.closeReason };
}

/** True when `closedAt` is within `withinMs` of now (inclusive of clock skew). */
export function isRecentClose(closedAt: string, withinMs: number, now = Date.now()): boolean {
  const t = new Date(closedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= -60_000 && age < withinMs;
}

function fmtAge(closedAt: string, now = Date.now()): string {
  const ageMs = Math.max(0, now - new Date(closedAt).getTime());
  const mins = Math.round(ageMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function fmtPnlUsd(pnl: number): string {
  const abs = Math.abs(pnl);
  const body = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return `${pnl >= 0 ? '+' : '-'}$${body}`;
}

function closeHowLabel(reason: string | null, pnl: number | null): string {
  if (reason === 'stop_fill') return 'protective stop filled';
  if (reason === 'take_profit_fill') return 'take-profit filled';
  if (reason === 'liquidated') return 'liquidated';
  if (reason === 'cut' || reason === 'exit' || reason === 'flip' || reason === 'trim_escalated') {
    return 'agent closed';
  }
  if (reason === 'margin_dust') return 'margin-dust stub closed';
  if (reason === 'closed_externally' || reason === 'adopted_on_revoke') {
    return pnl != null && pnl >= 0
      ? 'user/exchange flatten (profit booked outside monitor)'
      : 'user/exchange flatten (outside monitor)';
  }
  return reason ? `closed (${reason})` : 'closed';
}

/**
 * Compact opening-prompt card for a recent close on this symbol.
 * Soft context only — does not force FLAT.
 */
export function renderLastSymbolCloseSection(
  close: LastSymbolClose | null | undefined,
): string {
  if (!close) return '';
  const side = close.direction ?? 'position';
  const how = closeHowLabel(close.closeReason, close.realizedPnl);
  const px =
    close.closePrice != null && close.closePrice > 0
      ? ` at ~$${close.closePrice >= 100 ? close.closePrice.toFixed(2) : close.closePrice.toPrecision(4)}`
      : '';
  const pnl =
    close.realizedPnl != null && Number.isFinite(close.realizedPnl)
      ? ` · realized ${fmtPnlUsd(close.realizedPnl)}`
      : '';
  const age = fmtAge(close.closedAt);
  const sameSideHint =
    close.direction === 'LONG' || close.direction === 'SHORT'
      ? ` Same-side (${close.direction}) reopen needs clearer confirmation than usual.`
      : '';
  return `

**LAST CLOSE** (this symbol · ${age}):
- ${side} ${how}${px}${pnl}
- Context only: do not chase the same exit move. Re-enter only with a *fresh* edge.${sameSideHint}`;
}

export interface PreviousMonitorDecision {
  timestamp: string;
  action: string;
  reasoning: string;
  /** Price-% basis (same as the live unrealized_pnl_pct fed to prompts). */
  pnl_pct: number;
  /** Model-reported thesis conviction (0-100) at that check; null on legacy rows. */
  thesis_conviction: number | null;
  /** thesis_status from that check; null on legacy / winning rows that omitted it. */
  thesis_status: 'INTACT' | 'WEAKENED' | 'INVALIDATED' | null;
  /** Set when the engine did not run the model's action (young/dust trim → hold). */
  engineNote?: string;
}

/**
 * Last monitor decisions for one position (since it opened), oldest-first —
 * feeds the monitor prompts' P&L-momentum rules, which are dead with an
 * empty history. Reads the logged `pricePct` (price-% basis); rows logged
 * before that field existed are skipped rather than mixing ROE into the
 * momentum math.
 */
export async function getRecentMonitorDecisions(args: {
  agentId: string;
  symbol: string;
  sinceIso: string;
  limit?: number;
}): Promise<PreviousMonitorDecision[]> {
  const { data, error } = await getSupabase()
    .from('ai_agent_decisions')
    .select('created_at, type, decision')
    .eq('agent_id', args.agentId)
    .eq('symbol', args.symbol)
    .in('type', ['monitor_win', 'monitor_loss', 'monitor_win_dry_run', 'monitor_loss_dry_run'])
    .gte('created_at', args.sinceIso)
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 3);
  if (error) throw new Error(`getRecentMonitorDecisions: ${error.message}`);

  const out: PreviousMonitorDecision[] = [];
  for (const row of data ?? []) {
    const d = (row as { decision?: Record<string, unknown> }).decision ?? {};
    const pricePct = Number((d as { pricePct?: unknown }).pricePct);
    if (!Number.isFinite(pricePct)) continue;
    const body = (d as {
      decisionBody?: {
        reason?: unknown;
        thesis_conviction?: unknown;
        thesis_status?: unknown;
        trimSkippedYoung?: unknown;
        llmAction?: unknown;
      };
    }).decisionBody;
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    const tc = Number(body?.thesis_conviction);
    const tsRaw = body?.thesis_status;
    const thesis_status =
      tsRaw === 'INTACT' || tsRaw === 'WEAKENED' || tsRaw === 'INVALIDATED'
        ? tsRaw
        : null;
    const heldYoung = body?.trimSkippedYoung === true;
    const llmAction = typeof body?.llmAction === 'string' ? body.llmAction : '';
    out.push({
      timestamp: String((row as { created_at?: unknown }).created_at ?? ''),
      action: String((d as { action?: unknown }).action ?? 'hold'),
      reasoning: reason.length > 180 ? `${reason.slice(0, 177)}...` : reason,
      pnl_pct: pricePct,
      thesis_conviction: Number.isFinite(tc) ? Math.round(tc) : null,
      thesis_status,
      engineNote:
        heldYoung && llmAction
          ? `engine held; model asked ${llmAction} because the position was too young or small to trim`
          : undefined,
    });
  }
  return out.reverse(); // oldest → newest (prompts read slice(-2) chronologically)
}

/**
 * Compact attribution for `ai_agent_decisions.reasoning`.
 * Normally never stores the full LLM prompt — UI only shows the short
 * decision.reasoning text, and prompts were ~9KB each (dominant list-payload
 * cost). Debug spot-checks: set `DEBUG_STORE_PROMPTS=1` (until unset) or
 * `DEBUG_STORE_PROMPTS=<ISO timestamp / epoch ms>` (auto-expires — set it to
 * "tomorrow" and forget it) to persist prompts under `reasoning.prompt`.
 */
export function buildStoredLlmReasoning(args: {
  provider?: string;
  model?: string;
  latencyMs?: number;
  /** Raw model reply — only when decision body wasn't parsed (invalid/error). */
  response?: string;
  /** Full prompt — persisted ONLY while the debug env flag is active. */
  prompt?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.provider) out.provider = args.provider;
  if (args.model) out.model = args.model;
  if (typeof args.latencyMs === 'number' && Number.isFinite(args.latencyMs)) {
    out.latencyMs = args.latencyMs;
  }
  if (typeof args.response === 'string' && args.response.trim()) {
    out.response = args.response;
  }
  if (promptDebugActive() && typeof args.prompt === 'string' && args.prompt.trim()) {
    out.prompt = args.prompt;
    out.promptDebug = true; // marks rows to purge after a debug session
  }
  return out;
}

function promptDebugActive(): boolean {
  const raw = (process.env.DEBUG_STORE_PROMPTS ?? '').trim();
  if (!raw) return false;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  const asNum = Number(raw);
  const until = Number.isFinite(asNum) && asNum > 0 ? asNum : Date.parse(raw);
  return Number.isFinite(until) && Date.now() < until;
}

export async function logDecision(args: {
  agentId: string;
  runId: string | null;
  symbol: string | null;
  type: string;
  decision?: unknown;
  reasoning?: unknown;
  /** LLM attribution for usage analytics; omit for non-LLM rows. */
  provider?: string;
  model?: string;
}): Promise<void> {
  const { error } = await getSupabase().from('ai_agent_decisions').insert({
    agent_id: args.agentId,
    run_id: args.runId,
    symbol: args.symbol,
    type: args.type,
    decision: args.decision ?? null,
    reasoning: args.reasoning ?? null,
    provider: args.provider ?? null,
    model: args.model ?? null,
  });
  if (error) console.error(`logDecision failed (${args.type}):`, error.message);
}
