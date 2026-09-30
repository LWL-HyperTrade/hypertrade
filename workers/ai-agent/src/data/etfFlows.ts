/**
 * CoinGlass spot-ETF flow history — daily institutional-demand context.
 *
 * Endpoints (v4, Hobbyist-covered):
 *   /api/etf/{bitcoin|ethereum|solana|xrp}/flow-history
 *
 * Spot ETFs exist only for BTC / ETH / SOL / XRP — every other symbol skips
 * this entirely, same pattern as Deribit DVOL being BTC/ETH-only. Flows are
 * reported once per US trading day, so the series is globally cached in
 * `global_context_cache` (shared across agents, replicas and restarts) with a
 * 6h TTL — a handful of CoinGlass GETs per day total, regardless of agent
 * count.
 *
 * This is a DAILY bias signal (institutional demand day-over-day), not an
 * intraday trigger — the prompt section says so explicitly.
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

const BASE = 'https://open-api-v4.coinglass.com';

/** HL coin → CoinGlass ETF endpoint slug. Only these four have spot ETFs. */
const ETF_SLUGS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'xrp',
};

export function supportsEtfFlows(hlCoin: string): boolean {
  return hlCoin.toUpperCase() in ETF_SLUGS;
}

const ETF_TTL_MS = 6 * 60 * 60 * 1000; // flows update once per trading day

export interface EtfFlowsContext {
  asset: string;
  /** ISO date (UTC) of the most recent reported day. */
  lastDate: string;
  lastFlowUsd: number;
  prevFlowUsd: number | null;
  sum5dUsd: number;
  sum30dUsd: number;
  /** +N = N consecutive inflow days; −N = N consecutive outflow days. */
  streakDays: number;
  updatedAt: string;
}

interface RawFlowRow {
  timestamp?: number | string;
  flow_usd?: number | string;
}

async function fetchEtfFlowRows(slug: string, apiKey: string): Promise<{ ts: number; flow: number }[]> {
  const res = await fetch(`${BASE}/api/etf/${slug}/flow-history`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass etf/${slug} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: RawFlowRow[] };
  if (body.code !== '0') throw new Error(`CoinGlass etf/${slug} error: ${body.msg ?? body.code}`);
  const rows: { ts: number; flow: number }[] = [];
  for (const r of body.data ?? []) {
    const ts = Number(r.timestamp);
    const flow = Number(r.flow_usd);
    if (Number.isFinite(ts) && Number.isFinite(flow)) rows.push({ ts, flow });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

function buildContext(asset: string, rows: { ts: number; flow: number }[]): EtfFlowsContext | null {
  if (rows.length === 0) return null;
  const recent = rows.slice(-30);
  const lastRow = recent[recent.length - 1];
  const prevRow = recent.length >= 2 ? recent[recent.length - 2] : null;

  const sum = (n: number) => recent.slice(-n).reduce((s, r) => s + r.flow, 0);

  // Consecutive same-sign trading days counted from the latest day back.
  let streak = 0;
  const lastSign = Math.sign(lastRow.flow);
  if (lastSign !== 0) {
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      if (Math.sign(recent[i].flow) !== lastSign) break;
      streak += 1;
    }
    streak *= lastSign;
  }

  return {
    asset,
    lastDate: new Date(lastRow.ts).toISOString().slice(0, 10),
    lastFlowUsd: lastRow.flow,
    prevFlowUsd: prevRow ? prevRow.flow : null,
    sum5dUsd: sum(5),
    sum30dUsd: sum(30),
    streakDays: streak,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Globally-cached ETF flow context for one HL coin. Returns null for coins
 * without a spot ETF, on fetch failure with an empty cache, or when the
 * series is empty.
 */
export async function getEtfFlowsContext(
  hlCoin: string,
  apiKey: string,
): Promise<EtfFlowsContext | null> {
  if (config.coinankMode) return null;
  const sym = hlCoin.toUpperCase();
  const slug = ETF_SLUGS[sym];
  if (!slug) return null;
  return getOrRefreshGlobalContext<EtfFlowsContext | null>({
    key: `etf_flows_${sym}`,
    ttlMs: ETF_TTL_MS,
    produce: async () => buildContext(sym, await fetchEtfFlowRows(slug, apiKey)),
  });
}

/** Signed compact USD (+$12.4M / -$980K) — shared by prompt renderers. */
export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  const scaled =
    abs >= 1e9 ? `$${(abs / 1e9).toFixed(2)}B` : abs >= 1e6 ? `$${(abs / 1e6).toFixed(1)}M` : `$${(abs / 1e3).toFixed(0)}K`;
  return `${n < 0 ? '-' : '+'}${scaled}`;
}

/**
 * Prompt section shared by the opening + monitor prompts. Empty string when
 * no context (non-ETF symbols render nothing, like options for non-BTC/ETH).
 */
export function renderEtfFlowsSection(ctx: EtfFlowsContext | null | undefined): string {
  if (!ctx) return '';
  const streakText =
    ctx.streakDays > 0
      ? `${ctx.streakDays} consecutive INFLOW day${ctx.streakDays === 1 ? '' : 's'}`
      : ctx.streakDays < 0
        ? `${-ctx.streakDays} consecutive OUTFLOW day${ctx.streakDays === -1 ? '' : 's'}`
        : 'no streak (latest day ~flat)';
  return `

**INSTITUTIONAL DEMAND — SPOT ETF FLOWS (daily, ${ctx.asset})**:
- Latest reported day (${ctx.lastDate}): ${fmtUsd(ctx.lastFlowUsd)}${ctx.prevFlowUsd != null ? ` (prev day: ${fmtUsd(ctx.prevFlowUsd)})` : ''}
- 5-day net: ${fmtUsd(ctx.sum5dUsd)} | 30-day net: ${fmtUsd(ctx.sum30dUsd)}
- Streak: ${streakText}
- Interpretation: sustained inflows = structural demand tailwind (supports longs / cautions shorts); sustained outflows = institutional distribution. ETFs report once per US trading day — treat this as DAILY bias context, never as an intraday trigger.`;
}
