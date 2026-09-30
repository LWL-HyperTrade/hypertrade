/**
 * Hyperliquid $1M+ whale positions — CoinGlass `/api/hyperliquid/whale-position`
 * (Startup+ plans). Two per-symbol signals for the prompts:
 *
 *   • Whale bias — net long/short notional among $1M+ positions on THIS coin.
 *   • Liquidation clusters from REAL positions: short-position liq prices
 *     sitting ABOVE market = forced buying if price rises (squeeze fuel);
 *     long-position liq prices BELOW market = forced selling if price falls
 *     (cascade risk). This replaces CoinGlass's synthetic liquidation-map
 *     endpoints, which are Professional-tier only — and real venue positions
 *     are the stronger read anyway.
 *
 * One global fetch (all symbols in one response), cached 20 min. Rendering is
 * per symbol + current price at prompt-build time.
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';
import { getCoinankWhalePositions } from './coinank.js';
import { fmtUsd } from './etfFlows.js';

/** Trimmed whale position (only what rendering needs — keeps the cache lean). */
export interface WhalePos {
  symbol: string;
  /** +1 long, -1 short. */
  side: 1 | -1;
  valueUsd: number;
  liqPrice: number | null;
  leverage: number | null;
}

const TTL_MS = 20 * 60 * 1000;
/** Near / wide bands for liq-cluster USD (alts often have sparse ±5% pockets). */
const LIQ_NEAR_PCT = 0.03;
const LIQ_WIDE_PCT = 0.1;

interface CgWhaleRow {
  symbol?: string;
  position_size?: number | string;
  position_value_usd?: number | string;
  liq_price?: number | string;
  leverage?: number | string;
}

async function fetchWhalePositions(apiKey: string): Promise<WhalePos[]> {
  const res = await fetch('https://open-api-v4.coinglass.com/api/hyperliquid/whale-position', {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass whale-position HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: CgWhaleRow[] };
  if (body.code !== '0') throw new Error(`CoinGlass whale-position: ${body.msg ?? body.code}`);

  const out: WhalePos[] = [];
  for (const r of body.data ?? []) {
    const sym = String(r.symbol ?? '').toUpperCase();
    const size = Number(r.position_size);
    const value = Number(r.position_value_usd);
    if (!sym || !Number.isFinite(size) || size === 0 || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    const liq = Number(r.liq_price);
    const lev = Number(r.leverage);
    out.push({
      symbol: sym,
      side: size > 0 ? 1 : -1,
      valueUsd: value,
      liqPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
      leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
    });
  }
  return out;
}

export async function getHlWhalePositions(): Promise<WhalePos[] | null> {
  if (config.coinankMode) return getCoinankWhalePositions();
  const key = config.coinglassHouseKey;
  if (!key) return null;
  return getOrRefreshGlobalContext<WhalePos[]>({
    key: 'hl_whale_positions_v1',
    ttlMs: TTL_MS,
    produce: () => fetchWhalePositions(key),
  });
}

/**
 * Per-symbol prompt section (≤4 lines). Empty string when no whale has a
 * position on the coin (most alts) or the feed is unavailable.
 */
export function renderWhaleSection(
  positions: WhalePos[] | null | undefined,
  symbol: string,
  currentPrice: number,
): string {
  if (!positions || !(currentPrice > 0)) return '';
  const rows = positions.filter((p) => p.symbol === symbol.toUpperCase());
  if (rows.length === 0) return '';

  let longUsd = 0;
  let shortUsd = 0;
  let longCount = 0;
  let shortCount = 0;
  // Liq value within ±bands of current price. Shorts liquidate ABOVE market,
  // longs BELOW — anything else (already-past liq marks, stale rows) is noise.
  let shortLiqNear = 0;
  let shortLiqWide = 0;
  let longLiqNear = 0;
  let longLiqWide = 0;

  for (const p of rows) {
    if (p.side === 1) {
      longUsd += p.valueUsd;
      longCount += 1;
    } else {
      shortUsd += p.valueUsd;
      shortCount += 1;
    }
    if (p.liqPrice == null) continue;
    const dist = (p.liqPrice - currentPrice) / currentPrice;
    if (p.side === -1 && dist > 0) {
      if (dist <= LIQ_NEAR_PCT) shortLiqNear += p.valueUsd;
      if (dist <= LIQ_WIDE_PCT) shortLiqWide += p.valueUsd;
    } else if (p.side === 1 && dist < 0) {
      if (dist >= -LIQ_NEAR_PCT) longLiqNear += p.valueUsd;
      if (dist >= -LIQ_WIDE_PCT) longLiqWide += p.valueUsd;
    }
  }

  const nearLabel = `${Math.round(LIQ_NEAR_PCT * 100)}%`;
  const wideLabel = `${Math.round(LIQ_WIDE_PCT * 100)}%`;
  const net = longUsd - shortUsd;
  const lines: string[] = [
    `- Whale bias ($1M+ positions): ${longCount} long / ${shortCount} short, net ${fmtUsd(net)} ${net >= 0 ? 'LONG' : 'SHORT'}`,
  ];
  if (shortLiqWide > 0) {
    lines.push(
      `- Short-liq fuel ABOVE price: ${fmtUsd(shortLiqNear)} within +${nearLabel}, ${fmtUsd(shortLiqWide)} within +${wideLabel} (forced buying if price rises)`,
    );
  }
  if (longLiqWide > 0) {
    lines.push(
      `- Long-liq risk BELOW price: ${fmtUsd(longLiqNear)} within -${nearLabel}, ${fmtUsd(longLiqWide)} within -${wideLabel} (cascade fuel if price falls)`,
    );
  }
  if (lines.length === 1 && rows.every((p) => p.liqPrice == null)) {
    // Bias only — no liq data on any row; still worth the one line.
  }

  return `

**HL WHALE POSITIONS (${symbol.toUpperCase()}, real $1M+ positions on this venue)**:
${lines.join('\n')}
- Read: nearby liq clusters act as magnets/accelerants — squeeze fuel above favors upside continuation once moving; cascade fuel below deepens breakdowns. Context, not a trigger.`;
}
