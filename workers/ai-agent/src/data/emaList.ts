/**
 * CoinGlass /api/futures/ema/list — live EMA stack. One global fetch
 * (~30 min TTL); resolve per HIP-3 coin at prompt time.
 *
 * Aliases from the live dump (emas-dump.txt): GOLD→XAUT/XAU, SILVER→XAG,
 * PLATINUM→XPT, PALLADIUM→XPD, BRENTOIL→BZ, SMSN→SAMSUNG, SKHY→SKHY/SKHYNIX.
 * CL needs no alias. SP500/XYZ100 have no same-scale CG EMA — soft-skip;
 * SPY/QQQ feed macro-beta %/stack only. Missing → never invent levels.
 */
import { config } from '../config.js';
import { coinPart, isHip3Symbol } from '../brain/assetClass.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

const PATH = '/api/futures/ema/list';
const TTL_MS = 30 * 60 * 1000;

/**
 * HL / display coin → CoinGlass EMA candidates (tried in order).
 * Verified against CoinGlass Standard dump 2026-07-21:
 *   - SKHY: HL + Nasdaq ADS coin; CG may list SKHY or legacy SKHYNIX
 *   - CL: CG has CL (~$82 WTI) directly — OIL is UI-only, no alias
 *   - SP500 / XYZ100: NO same-scale CG series (SPY~740 / QQQ~696 vs
 *     index perps at 7k / ~25k). Do NOT alias — soft-skip asset EMAs;
 *     ETF direction lives only in macro-beta (% / stack, not $ levels).
 *   - CG "SPX" (~$0.36) is unrelated junk — never use it.
 */
const EMA_SYMBOL_ALIASES: Record<string, string[]> = {
  GOLD: ['XAUT', 'XAU'],
  SILVER: ['XAG'],
  PLATINUM: ['XPT'],
  PALLADIUM: ['XPD'],
  BRENTOIL: ['BZ'],
  SMSN: ['SAMSUNG'],
  SKHY: ['SKHY', 'SKHYNIX'],
};

export interface EmaRow {
  symbol: string;
  close: number | null;
  ema1h: number | null;
  ema4h: number | null;
  ema1d: number | null;
  ema1w: number | null;
}

export interface EmaContext {
  symbol: string;
  /** CoinGlass symbol actually looked up (may be aliased). */
  cgSymbol: string;
  close: number | null;
  ema1h: number | null;
  ema4h: number | null;
  ema1d: number | null;
  ema1w: number | null;
  /** close vs ema_1d in % (positive = above). */
  vsEma1dPct: number | null;
  vsEma1wPct: number | null;
  /** Stack: price > 4h > 1d > 1w → bullish, reverse → bearish, else mixed. */
  stack: 'bullish' | 'bearish' | 'mixed' | 'na';
  /**
   * Set on the Massive daily proxy (50-day). Unset on the CoinGlass 4h/1d/1w
   * stack, which keeps the original "1d EMA" wording.
   */
  trendLabel?: '50d';
}

export interface MacroBetaContext {
  /** SPY ETF — S&P risk-on proxy (%/stack only). */
  sp500: EmaContext | null;
  /** QQQ ETF — Nasdaq-100 / tech risk-on proxy (%/stack only). */
  qqq: EmaContext | null;
  dxy: EmaContext | null;
}

interface RawEma {
  symbol?: string;
  close_price?: number | string;
  ema_1h?: number | string;
  ema_4h?: number | string;
  ema_1d?: number | string;
  ema_1w?: number | string;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctVs(close: number | null, ema: number | null): number | null {
  if (close == null || ema == null || ema === 0) return null;
  return ((close - ema) / ema) * 100;
}

function stackOf(row: {
  close: number | null;
  ema4h: number | null;
  ema1d: number | null;
  ema1w: number | null;
}): EmaContext['stack'] {
  const { close, ema4h, ema1d, ema1w } = row;
  if (close == null || ema4h == null || ema1d == null || ema1w == null) return 'na';
  if (close > ema4h && ema4h > ema1d && ema1d > ema1w) return 'bullish';
  if (close < ema4h && ema4h < ema1d && ema1d < ema1w) return 'bearish';
  return 'mixed';
}

function toRow(r: RawEma): EmaRow | null {
  const symbol = String(r.symbol ?? '').toUpperCase();
  if (!symbol) return null;
  return {
    symbol,
    close: num(r.close_price),
    ema1h: num(r.ema_1h),
    ema4h: num(r.ema_4h),
    ema1d: num(r.ema_1d),
    ema1w: num(r.ema_1w),
  };
}

async function produce(apiKey: string): Promise<Record<string, EmaRow>> {
  const res = await fetch(`https://open-api-v4.coinglass.com${PATH}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${PATH} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: RawEma[] };
  if (body.code !== '0') throw new Error(`CoinGlass ${PATH}: ${body.msg ?? body.code}`);
  const out: Record<string, EmaRow> = {};
  for (const raw of body.data ?? []) {
    const row = toRow(raw);
    if (row) out[row.symbol] = row;
  }
  return out;
}

async function getEmaMap(): Promise<Record<string, EmaRow> | null> {
  const key = config.coinglassHouseKey;
  if (!key) return null;
  return getOrRefreshGlobalContext({
    key: 'coinglass_ema_list_v1',
    ttlMs: TTL_MS,
    produce: () => produce(key),
  });
}

/** Candidates to try for a coin (canonical first, then aliases). */
function emaCandidates(hlCoin: string): string[] {
  const base = coinPart(hlCoin);
  const aliases = EMA_SYMBOL_ALIASES[base] ?? [];
  return [base, ...aliases.filter((a) => a !== base)];
}

function lookupRow(
  map: Record<string, EmaRow>,
  candidates: string[],
): { row: EmaRow; cgSymbol: string } | null {
  for (const c of candidates) {
    const row = map[c];
    if (row) return { row, cgSymbol: row.symbol };
  }
  return null;
}

function ctxFromRow(displaySymbol: string, cgSymbol: string, row: EmaRow): EmaContext {
  return {
    symbol: displaySymbol,
    cgSymbol,
    close: row.close,
    ema1h: row.ema1h,
    ema4h: row.ema4h,
    ema1d: row.ema1d,
    ema1w: row.ema1w,
    vsEma1dPct: pctVs(row.close, row.ema1d),
    vsEma1wPct: pctVs(row.close, row.ema1w),
    stack: stackOf(row),
  };
}

export async function getEmaContext(hlCoin: string): Promise<EmaContext | null> {
  if (config.coinankMode) return null;
  const map = await getEmaMap();
  if (!map) return null;
  const display = coinPart(hlCoin);
  const hit = lookupRow(map, emaCandidates(hlCoin));
  if (!hit) return null;
  return ctxFromRow(display, hit.cgSymbol, hit.row);
}

/**
 * Risk-on ETF proxies for HIP-3 prompts — SPY (S&P) + QQQ (Nasdaq-100).
 * Used ONLY for % vs EMA and stack direction. Absolute $ levels are ETF
 * prices, not tradeXYZ index perps (SP500 ~7k, XYZ100 ~25k) — never splice
 * these closes into an asset's own EMA block.
 */
export async function getMacroBetaContext(): Promise<MacroBetaContext> {
  if (config.coinankMode) return { sp500: null, dxy: null, qqq: null };
  const map = await getEmaMap();
  if (!map) return { sp500: null, dxy: null, qqq: null };
  const spHit = lookupRow(map, ['SPY']);
  const qqHit = lookupRow(map, ['QQQ']);
  const dxHit = lookupRow(map, ['DXY']);
  return {
    sp500: spHit ? ctxFromRow('SPY', spHit.cgSymbol, spHit.row) : null,
    qqq: qqHit ? ctxFromRow('QQQ', qqHit.cgSymbol, qqHit.row) : null,
    dxy: dxHit ? ctxFromRow('DXY', dxHit.cgSymbol, dxHit.row) : null,
  };
}

function fmtPct(n: number | null): string {
  if (n == null) return 'N/A';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPx(n: number | null): string {
  if (n == null) return 'N/A';
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function renderEmaSection(
  ctx: EmaContext | null | undefined,
  opts?: { hip3?: boolean },
): string {
  if (!ctx) {
    // HIP-3 without a CoinGlass EMA row (EUR/JPY/XYZ100/…) — say so
    // explicitly so the model does not invent levels.
    if (opts?.hip3) {
      return `

**TREND EMAs**: Unavailable for this symbol on CoinGlass — judge on flow/OI/macro/session alone; do **not** invent EMA levels.`;
    }
    return '';
  }
  const alias =
    ctx.cgSymbol !== ctx.symbol ? ` (EMA via ${ctx.cgSymbol})` : '';
  const stackLabel =
    ctx.stack === 'bullish'
      ? 'BULLISH (price > 4h > 1d > 1w)'
      : ctx.stack === 'bearish'
        ? 'BEARISH (price < 4h < 1d < 1w)'
        : ctx.stack === 'mixed'
          ? 'MIXED'
          : 'N/A';
  return `

**TREND EMAs**${alias} (CoinGlass live stack — prefer 1d/1w over 1h noise for HIP-3):
- Close ${fmtPx(ctx.close)} | EMA 4h ${fmtPx(ctx.ema4h)} | 1d ${fmtPx(ctx.ema1d)} | 1w ${fmtPx(ctx.ema1w)}
- vs EMA 1d: ${fmtPct(ctx.vsEma1dPct)} | vs EMA 1w: ${fmtPct(ctx.vsEma1wPct)}
- Stack: **${stackLabel}**`;
}

export function renderMacroBetaSection(
  beta: MacroBetaContext | null | undefined,
  opts?: { forHip3?: boolean },
): string {
  if (!opts?.forHip3 || !beta) return '';
  const bits: string[] = [];
  // Deliberately omit absolute ETF prices — they are NOT tradeXYZ index levels.
  if (beta.sp500) {
    const vs = beta.sp500.trendLabel === '50d' ? 'vs 50d EMA' : 'vs 1d EMA';
    bits.push(
      `SPY (S&P ETF proxy): ${fmtPct(beta.sp500.vsEma1dPct)} ${vs}, stack ${beta.sp500.stack}`,
    );
  }
  if (beta.qqq) {
    const vs = beta.qqq.trendLabel === '50d' ? 'vs 50d EMA' : 'vs 1d EMA';
    bits.push(
      `QQQ (Nasdaq-100 ETF proxy): ${fmtPct(beta.qqq.vsEma1dPct)} ${vs}, stack ${beta.qqq.stack}`,
    );
  }
  if (beta.dxy) {
    const vs = beta.dxy.trendLabel === '50d' ? 'vs 50d EMA' : 'vs 1d EMA';
    bits.push(
      `DXY: ${fmtPct(beta.dxy.vsEma1dPct)} ${vs}, stack ${beta.dxy.stack}`,
    );
  }
  if (bits.length === 0) return '';
  return `

**MACRO BETA** (ETF direction only — %/stack, not $ levels; index perps have different price scales):
- ${bits.join(' · ')}`;
}

export function wantsEmaContext(hlCoin: string): boolean {
  return isHip3Symbol(hlCoin);
}
