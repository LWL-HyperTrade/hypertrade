/**
 * Hyperliquid wallet-cohort positioning — CoinGlass Standard endpoints:
 *   /api/hyperliquid/wallet/position-distribution  (size tiers: shrimp→leviathan)
 *   /api/hyperliquid/wallet/pnl-distribution       (PnL tiers: money_printer→giga_rekt)
 *
 * Why these over long/short account ratios: account-count ratios are polluted
 * by spam/dust accounts and hide WHO is on each side. These are position-VALUE
 * weighted and cohort-segmented, so the prompts get the actual story:
 * "smart money net short while shrimp are max long" (crowd fade setup) vs
 * "smart money and whales aligned long" (positioning tailwind).
 *
 * Platform-wide (not per-symbol) — rendered as context, never a trigger.
 * Globally cached, 30 min TTL (endpoint is realtime; our cycle is hourly).
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

interface CgCohortRow {
  group_name?: string;
  long_position_usd?: number | string;
  short_position_usd?: number | string;
}

export interface HlPositioningContext {
  /** Value-weighted % of cohort notional that is LONG (0–100). */
  retailLongPct: number | null; // shrimp + fish
  whaleLongPct: number | null; // small_whale..leviathan
  smartMoneyLongPct: number | null; // money_printer + smart_money
  rektLongPct: number | null; // exit_liquidity..giga_rekt
  updatedAt: string;
}

const TTL_MS = 30 * 60 * 1000;

const RETAIL_TIERS = new Set(['shrimp', 'fish']);
const WHALE_TIERS = new Set(['small_whale', 'whale', 'tidal_whale', 'leviathan']);
const SMART_TIERS = new Set(['money_printer', 'smart_money']);
const REKT_TIERS = new Set(['exit_liquidity', 'semi_rekt', 'full_rekt', 'giga_rekt']);

async function fetchRows(path: string, apiKey: string): Promise<CgCohortRow[]> {
  const res = await fetch(`https://open-api-v4.coinglass.com${path}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${path} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: CgCohortRow[] };
  if (body.code !== '0') throw new Error(`CoinGlass ${path}: ${body.msg ?? body.code}`);
  return body.data ?? [];
}

/** Value-weighted long % across the rows whose tier is in `tiers`. */
function longPct(rows: CgCohortRow[], tiers: Set<string>): number | null {
  let long = 0;
  let short = 0;
  for (const r of rows) {
    const name = String(r.group_name ?? '').toLowerCase();
    if (!tiers.has(name)) continue;
    const l = Number(r.long_position_usd);
    const s = Number(r.short_position_usd);
    if (Number.isFinite(l)) long += l;
    if (Number.isFinite(s)) short += s;
  }
  const total = long + short;
  return total > 0 ? (long / total) * 100 : null;
}

async function produce(apiKey: string): Promise<HlPositioningContext | null> {
  const [posRows, pnlRows] = await Promise.all([
    fetchRows('/api/hyperliquid/wallet/position-distribution', apiKey).catch(() => null),
    fetchRows('/api/hyperliquid/wallet/pnl-distribution', apiKey).catch(() => null),
  ]);
  if (!posRows && !pnlRows) return null;
  return {
    retailLongPct: posRows ? longPct(posRows, RETAIL_TIERS) : null,
    whaleLongPct: posRows ? longPct(posRows, WHALE_TIERS) : null,
    smartMoneyLongPct: pnlRows ? longPct(pnlRows, SMART_TIERS) : null,
    rektLongPct: pnlRows ? longPct(pnlRows, REKT_TIERS) : null,
    updatedAt: new Date().toISOString(),
  };
}

export async function getHlPositioning(): Promise<HlPositioningContext | null> {
  if (config.coinankMode) return null;
  const key = config.coinglassHouseKey;
  if (!key) return null; // Standard-only endpoints — house-key path only.
  return getOrRefreshGlobalContext<HlPositioningContext | null>({
    key: 'hl_positioning_v1',
    ttlMs: TTL_MS,
    produce: () => produce(key),
  });
}

const pct = (v: number | null): string => (v != null ? `${v.toFixed(0)}% long` : 'N/A');

/**
 * Compact prompt section (3 lines). Empty string when unavailable.
 * Platform-wide HL cohort positioning — explicitly framed as context.
 */
export function renderHlPositioningSection(ctx: HlPositioningContext | null | undefined): string {
  if (!ctx) return '';
  const hasAny =
    ctx.retailLongPct != null || ctx.whaleLongPct != null ||
    ctx.smartMoneyLongPct != null || ctx.rektLongPct != null;
  if (!hasAny) return '';

  const smartVsCrowd =
    ctx.smartMoneyLongPct != null && ctx.retailLongPct != null
      ? ctx.smartMoneyLongPct >= 55 && ctx.retailLongPct <= 45
        ? ' → smart money long vs crowd short (bullish skew)'
        : ctx.smartMoneyLongPct <= 45 && ctx.retailLongPct >= 55
          ? ' → smart money short vs crowd long (bearish skew)'
          : ''
      : '';

  return `

**HYPERLIQUID POSITIONING (platform-wide, position-value weighted)**:
- Whales: ${pct(ctx.whaleLongPct)} | Retail (shrimp/fish): ${pct(ctx.retailLongPct)}
- Top-PnL "smart money": ${pct(ctx.smartMoneyLongPct)} | Worst-PnL "exit liquidity": ${pct(ctx.rektLongPct)}${smartVsCrowd}
- Read: side WITH smart money / AGAINST a crowded retail side carries extra weight; this is platform-wide context, never a standalone trigger.`;
}
