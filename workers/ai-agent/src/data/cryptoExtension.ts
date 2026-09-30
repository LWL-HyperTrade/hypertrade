/**
 * Crypto-only EXTENSION / EXHAUSTION context — stretch features for prompts.
 *
 * Soft guidance only (no worker gate, no composite "extension score").
 * Built from CoinGlass RSI + EMA lists, or on the CoinAnk path from the RSI map
 * plus EMAs of the fetched klines. Local wall-clock run-up / funding / OI
 * percentiles always come from the bars already fetched.
 *
 * Gated by isCryptoAsset — never attach to equities/metals/HIP-3 stocks.
 */
import { config } from '../config.js';
import { coinPart, isCryptoAsset } from '../brain/assetClass.js';
import type { FuturesBar } from '../brain/computeScalperFlags.js';
import { getEmaContext } from './emaList.js';
import { getCoinankRsiContext } from './coinank.js';
import { getRsiContext } from './rsiList.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 5 * DAY_MS;
const RUNUP_MS = 3 * DAY_MS;

export interface CryptoExtensionContext {
  symbol: string;
  rsi1h: number | null;
  rsi4h: number | null;
  rsi1d: number | null;
  vsEma4hPct: number | null;
  vsEma1dPct: number | null;
  vsEma1wPct: number | null;
  /** Price change over the last ~3 wall-clock days (%). */
  runUp3dPct: number | null;
  /** Percentile of current 3d run-up among rolling 3d returns in the 5d window. */
  runUp3dPctl: number | null;
  /** % below the 5d high (0 = at high). */
  off5dHighPct: number | null;
  fundingBps: number | null;
  fundingPctl: number | null;
  oiPctl: number | null;
  /** Soft tags for prompt rules — NOT a numeric score. */
  stretched: boolean;
  oversold: boolean;
  fundingCrowdedLong: boolean;
  fundingCrowdedShort: boolean;
}

function pctVs(close: number | null, ema: number | null): number | null {
  if (close == null || ema == null || ema === 0) return null;
  return ((close - ema) / ema) * 100;
}

function percentileRank(arr: number[], v: number): number | null {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length || !Number.isFinite(v)) return null;
  let count = 0;
  for (const x of a) if (x <= v) count += 1;
  return (count / a.length) * 100;
}

/** Closest bar at or before targetTs (bars ascending by timestamp). */
function closeAtOrBefore(bars: FuturesBar[], targetTs: number): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.timestamp > targetTs) break;
    const c = Number(b.close_price);
    if (Number.isFinite(c) && c > 0) best = c;
  }
  return best;
}

function computeLocalStretch(bars: FuturesBar[]): {
  runUp3dPct: number | null;
  runUp3dPctl: number | null;
  off5dHighPct: number | null;
  fundingBps: number | null;
  fundingPctl: number | null;
  oiPctl: number | null;
} {
  const empty = {
    runUp3dPct: null,
    runUp3dPctl: null,
    off5dHighPct: null,
    fundingBps: null,
    fundingPctl: null,
    oiPctl: null,
  };
  if (!bars.length) return empty;

  const sorted = bars
    .filter((b) => Number.isFinite(b.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const nowTs = last.timestamp;
  const windowStart = nowTs - LOOKBACK_MS;
  const win = sorted.filter((b) => b.timestamp >= windowStart);
  if (win.length < 4) return empty;

  const lastClose = Number(last.close_price);
  if (!Number.isFinite(lastClose) || lastClose <= 0) return empty;

  const close3dAgo = closeAtOrBefore(sorted, nowTs - RUNUP_MS);
  const runUp3dPct =
    close3dAgo != null && close3dAgo > 0
      ? ((lastClose - close3dAgo) / close3dAgo) * 100
      : null;

  // Rolling 3d returns ending at each bar in the 5d window (wall-clock).
  const rolling: number[] = [];
  for (const b of win) {
    const c = Number(b.close_price);
    if (!Number.isFinite(c) || c <= 0) continue;
    const ago = closeAtOrBefore(sorted, b.timestamp - RUNUP_MS);
    if (ago == null || ago <= 0) continue;
    rolling.push(((c - ago) / ago) * 100);
  }
  const runUp3dPctl =
    runUp3dPct != null ? percentileRank(rolling, runUp3dPct) : null;

  let high5d = -Infinity;
  for (const b of win) {
    const h = Number(b.high_price ?? b.close_price);
    if (Number.isFinite(h) && h > high5d) high5d = h;
  }
  const off5dHighPct =
    Number.isFinite(high5d) && high5d > 0
      ? ((high5d - lastClose) / high5d) * 100
      : null;

  const fundingNow = Number(last.funding_rate);
  const fundingHist = win
    .map((b) => Number(b.funding_rate))
    .filter((n) => Number.isFinite(n));
  const fundingBps = Number.isFinite(fundingNow) ? fundingNow * 10_000 : null;
  const fundingPctl = Number.isFinite(fundingNow)
    ? percentileRank(fundingHist, fundingNow)
    : null;

  const oiNow = Number(last.dollar_open_interest_close);
  const oiHist = win
    .map((b) => Number(b.dollar_open_interest_close))
    .filter((n) => Number.isFinite(n) && n > 0);
  const oiPctl = Number.isFinite(oiNow) && oiNow > 0
    ? percentileRank(oiHist, oiNow)
    : null;

  return {
    runUp3dPct,
    runUp3dPctl,
    off5dHighPct,
    fundingBps,
    fundingPctl,
    oiPctl,
  };
}

function tagStretch(args: {
  rsi4h: number | null;
  rsi1d: number | null;
  vsEma1dPct: number | null;
  runUp3dPctl: number | null;
  fundingBps: number | null;
  fundingPctl: number | null;
}): Pick<
  CryptoExtensionContext,
  'stretched' | 'oversold' | 'fundingCrowdedLong' | 'fundingCrowdedShort'
> {
  const { rsi4h, rsi1d, vsEma1dPct, runUp3dPctl, fundingBps, fundingPctl } = args;
  const fundingCrowdedLong =
    fundingPctl != null && fundingPctl >= 90 && (fundingBps ?? 0) > 0;
  const fundingCrowdedShort =
    fundingPctl != null && fundingPctl <= 10 && (fundingBps ?? 0) < 0;

  const stretched =
    (rsi4h != null && rsi4h >= 70) ||
    (rsi1d != null && rsi1d >= 70) ||
    (runUp3dPctl != null && runUp3dPctl >= 90) ||
    (vsEma1dPct != null && vsEma1dPct >= 8) ||
    fundingCrowdedLong;

  const oversold =
    (rsi4h != null && rsi4h <= 30) ||
    (rsi1d != null && rsi1d <= 30) ||
    (runUp3dPctl != null && runUp3dPctl <= 10) ||
    (vsEma1dPct != null && vsEma1dPct <= -8) ||
    fundingCrowdedShort;

  return { stretched, oversold, fundingCrowdedLong, fundingCrowdedShort };
}

function emaLast(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((s, c) => s + c, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

/** 4h / 1d / 1w distance from the fetched klines. Weekly needs ~168h of bars. */
function localEmaPcts(bars: FuturesBar[]): {
  vsEma4hPct: number | null;
  vsEma1dPct: number | null;
  vsEma1wPct: number | null;
} {
  const empty = { vsEma4hPct: null, vsEma1dPct: null, vsEma1wPct: null };
  const closes = bars
    .map((b) => Number(b.close_price))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 2) return empty;
  const prev = bars[bars.length - 2]?.timestamp;
  const lastTs = bars[bars.length - 1]?.timestamp;
  const barMs =
    Number.isFinite(prev) && Number.isFinite(lastTs) && lastTs > prev
      ? lastTs - prev
      : 60 * 60 * 1000;
  const perHour = (60 * 60 * 1000) / barMs;
  const close = closes[closes.length - 1];
  const vs = (hours: number) =>
    pctVs(close, emaLast(closes, Math.max(1, Math.round(hours * perHour))));
  return { vsEma4hPct: vs(4), vsEma1dPct: vs(24), vsEma1wPct: vs(168) };
}

/**
 * Build extension context for a crypto symbol. Returns null for non-crypto
 * or when there is nothing useful to show.
 */
export async function buildCryptoExtension(
  hlCoin: string,
  bars: FuturesBar[],
): Promise<CryptoExtensionContext | null> {
  if (!isCryptoAsset(hlCoin)) return null;

  const display = coinPart(hlCoin);
  const local = computeLocalStretch(bars);

  let rsi1h: number | null = null;
  let rsi4h: number | null = null;
  let rsi1d: number | null = null;
  let vsEma4hPct: number | null = null;
  let vsEma1dPct: number | null = null;
  let vsEma1wPct: number | null = null;

  if (config.coinankMode) {
    const rsi = await getCoinankRsiContext(hlCoin).catch(() => null);
    rsi1h = rsi?.rsi1h ?? null;
    rsi4h = rsi?.rsi4h ?? null;
    rsi1d = rsi?.rsi1d ?? null;
    const emas = localEmaPcts(bars);
    vsEma4hPct = emas.vsEma4hPct;
    vsEma1dPct = emas.vsEma1dPct;
    vsEma1wPct = emas.vsEma1wPct;
  } else {
    const [rsi, ema] = await Promise.all([
      getRsiContext(hlCoin).catch(() => null),
      getEmaContext(hlCoin).catch(() => null),
    ]);
    rsi1h = rsi?.rsi1h ?? null;
    rsi4h = rsi?.rsi4h ?? null;
    rsi1d = rsi?.rsi1d ?? null;
    const close = ema?.close ?? null;
    vsEma4hPct = pctVs(close, ema?.ema4h ?? null);
    vsEma1dPct = ema?.vsEma1dPct ?? pctVs(close, ema?.ema1d ?? null);
    vsEma1wPct = ema?.vsEma1wPct ?? pctVs(close, ema?.ema1w ?? null);
  }

  const tags = tagStretch({
    rsi4h,
    rsi1d,
    vsEma1dPct,
    runUp3dPctl: local.runUp3dPctl,
    fundingBps: local.fundingBps,
    fundingPctl: local.fundingPctl,
  });

  const ctx: CryptoExtensionContext = {
    symbol: display,
    rsi1h,
    rsi4h,
    rsi1d,
    vsEma4hPct,
    vsEma1dPct,
    vsEma1wPct,
    ...local,
    ...tags,
  };

  // Soft-skip empty shells (no RSI, no EMA stretch, no local stretch).
  const hasAny =
    ctx.rsi1h != null ||
    ctx.rsi4h != null ||
    ctx.rsi1d != null ||
    ctx.vsEma1dPct != null ||
    ctx.runUp3dPct != null ||
    ctx.fundingBps != null;
  return hasAny ? ctx : null;
}

function fmtN(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return n.toFixed(digits);
}

function fmtPct(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function rsiLabel(n: number | null): string {
  if (n == null) return '';
  if (n >= 70) return ' (overbought ≥70)';
  if (n <= 30) return ' (oversold ≤30)';
  return '';
}

/** Compact crypto-only prompt block. Empty string when unavailable / non-crypto. */
export function renderCryptoExtensionSection(
  ctx: CryptoExtensionContext | null | undefined,
): string {
  if (!ctx) return '';

  const rsiBits = [
    `1h ${fmtN(ctx.rsi1h)}`,
    `4h ${fmtN(ctx.rsi4h)}${rsiLabel(ctx.rsi4h)}`,
    `1d ${fmtN(ctx.rsi1d)}${rsiLabel(ctx.rsi1d)}`,
  ].join(' · ');

  const emaBits = [
    `${fmtPct(ctx.vsEma4hPct)} (4h)`,
    `${fmtPct(ctx.vsEma1dPct)} (1d)`,
    `${fmtPct(ctx.vsEma1wPct)} (1w)`,
  ].join(' · ');

  const runPctl =
    ctx.runUp3dPctl != null ? `${Math.round(ctx.runUp3dPctl)}th pctl of 5d` : 'N/A pctl';
  const offHigh =
    ctx.off5dHighPct != null ? `${fmtN(ctx.off5dHighPct)}% off 5d high` : 'N/A off high';

  let fundingNote = '';
  if (ctx.fundingCrowdedLong) fundingNote = ' — crowded longs';
  else if (ctx.fundingCrowdedShort) fundingNote = ' — crowded shorts';

  const fundPctl =
    ctx.fundingPctl != null ? `${Math.round(ctx.fundingPctl)}th pctl 5d` : 'N/A pctl';

  return `

**EXTENSION / EXHAUSTION (${ctx.symbol})** (condition, not a trade signal — crypto only):
- RSI: ${rsiBits}
- Price vs EMAs: ${emaBits}
- Run-up: ${fmtPct(ctx.runUp3dPct)} in 3d (${runPctl}) · ${offHigh}
- Funding: ${fmtN(ctx.fundingBps, 2)} bps (${fundPctl}${fundingNote})${ctx.oiPctl != null ? ` · OI ${Math.round(ctx.oiPctl)}th pctl 5d` : ''}
- Read: stretched + supply catalyst (UNLOCK/TOKENOMICS) or crowded funding = late-chase / trim-into-strength zone. Oversold + intact thesis = noise / DCA zone. **Never short a pump on RSI alone.**`;
}

/** Flat fields merged into opening `key_metrics` (and thesis snapshot). */
export function cryptoExtensionKeyMetrics(
  ctx: CryptoExtensionContext | null | undefined,
): Record<string, unknown> {
  if (!ctx) return {};
  return {
    rsi1h: ctx.rsi1h,
    rsi4h: ctx.rsi4h,
    rsi1d: ctx.rsi1d,
    vsEma4hPct: ctx.vsEma4hPct,
    vsEma1dPct: ctx.vsEma1dPct,
    vsEma1wPct: ctx.vsEma1wPct,
    runUp3dPct: ctx.runUp3dPct,
    runUp3dPctl: ctx.runUp3dPctl,
    off5dHighPct: ctx.off5dHighPct,
    fundingBps: ctx.fundingBps,
    fundingPctl: ctx.fundingPctl,
    oiPctl: ctx.oiPctl,
    stretched: ctx.stretched,
    oversold: ctx.oversold,
    fundingCrowdedLong: ctx.fundingCrowdedLong,
    fundingCrowdedShort: ctx.fundingCrowdedShort,
  };
}

/** Nested blob on decision rows for easy SQL / calibration (like compositeScore). */
export function cryptoExtensionLogFields(
  ctx: CryptoExtensionContext | null | undefined,
): Record<string, unknown> {
  const flat = cryptoExtensionKeyMetrics(ctx);
  if (Object.keys(flat).length === 0) return {};
  return { cryptoExtension: flat };
}

/** Soft opening rule when supply catalyst + stretch (text only). */
export function renderCryptoExtensionOpeningRules(
  ctx: CryptoExtensionContext | null | undefined,
): string {
  if (!ctx) return '';
  const stretchHint = ctx.stretched
    ? `
- **EXTENSION (soft)**: tape looks **stretched** right now. If a supply-side ticker catalyst (UNLOCK / TOKENOMICS) is pending, treat bullish micro as late-cycle — size down / wait for a flush; do **not** auto-bias SHORT on RSI alone.`
    : `
- **EXTENSION (soft)**: when a supply-side ticker catalyst (UNLOCK / TOKENOMICS) is pending **and** EXTENSION / EXHAUSTION looks stretched, treat bullish micro as late-cycle — size down or wait; never short solely because RSI is high.`;
  return stretchHint;
}
