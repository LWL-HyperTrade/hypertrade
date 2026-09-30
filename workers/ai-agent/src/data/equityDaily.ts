/**
 * Daily-bar trend context for HIP-3 — Massive stock aggregates.
 *
 * Perp candles for xyz markets are young/thin; real consolidated US daily
 * closes (years of history) are what an equity thesis should stand on:
 *   • EMA 20/50/200 stack from true daily closes
 *   • 52-week position (% off high / above low)
 *   • 1m/3m return + relative strength vs SPY
 *   • 20d realized vol (annualized)
 *
 * Same underlier resolution as equityOptions (equity coin part, GLD/SLV
 * metal proxies). Globally cached 6h — daily bars change once per session.
 */
import { config } from '../config.js';
import { coinPart } from '../brain/assetClass.js';
import { resolveOptionsTicker, metalsOptionsProxy } from './equityOptions.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';
import type { EmaContext, MacroBetaContext } from './emaList.js';

export interface EquityDailyContext {
  /** Massive ticker (TSLA, or GLD/SLV proxy for metals). */
  symbol: string;
  /** HIP-3 coin when this is a proxy (GOLD/SILVER); null for equities. */
  proxyFor?: string | null;
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  vsEma50Pct: number | null;
  vsEma200Pct: number | null;
  /** close > 20 > 50 > 200 → bullish; reverse → bearish; else mixed. */
  stack: 'bullish' | 'bearish' | 'mixed' | 'na';
  high52w: number | null;
  low52w: number | null;
  /** % below the 52-week high (negative number, e.g. -12.3). */
  pctFrom52wHigh: number | null;
  ret1mPct: number | null;
  ret3mPct: number | null;
  /** Return differential vs SPY over the same window (positive = outperforming). */
  rsVsSpy1mPct: number | null;
  rsVsSpy3mPct: number | null;
  realizedVol20dPct: number | null;
  barsUsed: number;
  updatedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const BASE = 'https://api.massive.com';
const LOOKBACK_DAYS = 430; // calendar days → ~290 trading bars (EMA200 + warmup)

const missingMemo = new Map<string, number>();
const MISSING_RECHECK_MS = 24 * 60 * 60 * 1000;

interface DailyBar {
  c?: number;
  t?: number;
}

async function fetchDailyCloses(ticker: string, apiKey: string): Promise<number[]> {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const res = await fetch(
    `${BASE}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`,
    { headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Massive daily aggs ${ticker} HTTP ${res.status}`);
  const body = (await res.json()) as { results?: DailyBar[] };
  return (body.results ?? [])
    .map((b) => Number(b.c))
    .filter((c) => Number.isFinite(c) && c > 0);
}

/** Standard EMA seeded with the SMA of the first `period` values. */
function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let value = closes.slice(0, period).reduce((s, c) => s + c, 0) / period;
  for (let i = period; i < closes.length; i += 1) {
    value = closes[i] * k + value * (1 - k);
  }
  return value;
}

function pctVs(close: number | null, ref: number | null): number | null {
  if (close == null || ref == null || ref === 0) return null;
  return ((close - ref) / ref) * 100;
}

function retPct(closes: number[], barsBack: number): number | null {
  if (closes.length <= barsBack) return null;
  const then = closes[closes.length - 1 - barsBack];
  const now = closes[closes.length - 1];
  return then > 0 ? ((now - then) / then) * 100 : null;
}

function realizedVolPct(closes: number[], window = 20): number | null {
  if (closes.length < window + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - window; i < closes.length; i += 1) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function contextFromCloses(
  ticker: string,
  proxyFor: string | null,
  closes: number[],
  spyCloses: number[] | null,
): EquityDailyContext {
  const close = closes.length > 0 ? closes[closes.length - 1] : null;
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const last252 = closes.slice(-252);
  const high52w = last252.length > 0 ? Math.max(...last252) : null;
  const low52w = last252.length > 0 ? Math.min(...last252) : null;

  let stack: EquityDailyContext['stack'] = 'na';
  if (close != null && e20 != null && e50 != null && e200 != null) {
    if (close > e20 && e20 > e50 && e50 > e200) stack = 'bullish';
    else if (close < e20 && e20 < e50 && e50 < e200) stack = 'bearish';
    else stack = 'mixed';
  }

  const ret1m = retPct(closes, 21);
  const ret3m = retPct(closes, 63);
  const spyRet1m = spyCloses ? retPct(spyCloses, 21) : null;
  const spyRet3m = spyCloses ? retPct(spyCloses, 63) : null;

  return {
    symbol: ticker,
    proxyFor,
    close,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    vsEma50Pct: pctVs(close, e50),
    vsEma200Pct: pctVs(close, e200),
    stack,
    high52w,
    low52w,
    pctFrom52wHigh: close != null && high52w != null && high52w > 0
      ? ((close - high52w) / high52w) * 100
      : null,
    ret1mPct: ret1m,
    ret3mPct: ret3m,
    rsVsSpy1mPct: ret1m != null && spyRet1m != null ? ret1m - spyRet1m : null,
    rsVsSpy3mPct: ret3m != null && spyRet3m != null ? ret3m - spyRet3m : null,
    realizedVol20dPct: realizedVolPct(closes),
    barsUsed: closes.length,
    updatedAt: new Date().toISOString(),
  };
}

/** Raw daily closes, globally cached (shared by asset context + SPY benchmark). */
async function getCachedCloses(ticker: string, apiKey: string): Promise<number[] | null> {
  const cached = await getOrRefreshGlobalContext<{ closes: number[] }>({
    key: `equity_daily_closes_${ticker}`,
    ttlMs: TTL_MS,
    produce: async () => ({ closes: await fetchDailyCloses(ticker, apiKey) }),
  });
  return cached?.closes?.length ? cached.closes : null;
}

export async function getEquityDailyContext(
  hlCoin: string,
): Promise<EquityDailyContext | null> {
  const ticker = resolveOptionsTicker(hlCoin);
  const apiKey = config.massiveApiKey;
  if (!ticker || !apiKey) return null;
  const missAt = missingMemo.get(ticker);
  if (missAt != null && Date.now() - missAt < MISSING_RECHECK_MS) return null;

  try {
    const [closes, spyCloses] = await Promise.all([
      getCachedCloses(ticker, apiKey),
      // Benchmark is best-effort — RS lines just render N/A without it.
      ticker === 'SPY' ? Promise.resolve(null) : getCachedCloses('SPY', apiKey).catch(() => null),
    ]);
    if (!closes || closes.length < 60) {
      missingMemo.set(ticker, Date.now());
      return null;
    }
    missingMemo.delete(ticker);
    const proxyFor = metalsOptionsProxy(hlCoin) ? coinPart(hlCoin) : null;
    return contextFromCloses(ticker, proxyFor, closes, spyCloses);
  } catch {
    return null;
  }
}

/** SPY/QQQ daily stack for HIP-3 macro beta when CoinGlass EMAs are not in use. */
async function massiveEmaProxy(ticker: string): Promise<EmaContext | null> {
  const apiKey = config.massiveApiKey;
  if (!apiKey) return null;
  const closes = await getCachedCloses(ticker, apiKey).catch(() => null);
  if (!closes || closes.length < 50) return null;
  const close = closes[closes.length - 1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  let stack: EmaContext['stack'] = 'na';
  if (e20 != null && e50 != null && e200 != null) {
    if (close > e20 && e20 > e50 && e50 > e200) stack = 'bullish';
    else if (close < e20 && e20 < e50 && e50 < e200) stack = 'bearish';
    else stack = 'mixed';
  }
  return {
    symbol: ticker,
    cgSymbol: ticker,
    close,
    ema1h: null,
    ema4h: e20,
    ema1d: e50,
    ema1w: e200,
    vsEma1dPct: pctVs(close, e50),
    vsEma1wPct: pctVs(close, e200),
    stack,
    trendLabel: '50d',
  };
}

export async function getMassiveMacroBetaContext(): Promise<MacroBetaContext> {
  if (!config.massiveApiKey) return { sp500: null, qqq: null, dxy: null };
  const [sp500, qqq] = await Promise.all([
    massiveEmaProxy('SPY'),
    massiveEmaProxy('QQQ'),
  ]);
  return { sp500, qqq, dxy: null };
}

function fmt(n: number | null, digits = 2): string {
  return n == null ? 'N/A' : n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtSigned(n: number | null): string {
  if (n == null) return 'N/A';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/**
 * Compact prompt block (~6 lines). NOTE for metals: levels are ETF ($GLD/
 * $SLV) — direction/stack/RS transfer to the metal, absolute $ do not.
 */
export function renderEquityDailySection(
  ctx: EquityDailyContext | null | undefined,
): string {
  if (!ctx || ctx.close == null) return '';
  const proxyNote = ctx.proxyFor
    ? ` (${ctx.symbol} ETF proxy for ${ctx.proxyFor} — use direction/stack, NOT $ levels)`
    : '';
  const stackLabel =
    ctx.stack === 'bullish'
      ? 'BULLISH (close > 20d > 50d > 200d)'
      : ctx.stack === 'bearish'
        ? 'BEARISH (close < 20d < 50d < 200d)'
        : ctx.stack.toUpperCase();
  const rs =
    ctx.rsVsSpy1mPct != null || ctx.rsVsSpy3mPct != null
      ? `\n- Relative strength vs SPY: 1m ${fmtSigned(ctx.rsVsSpy1mPct)} | 3m ${fmtSigned(ctx.rsVsSpy3mPct)}${(ctx.rsVsSpy3mPct ?? 0) > 5 ? ' — LEADER' : (ctx.rsVsSpy3mPct ?? 0) < -5 ? ' — LAGGARD' : ''}`
      : '';
  return `

**DAILY STRUCTURE${proxyNote}** (real US consolidated daily closes, ${ctx.barsUsed} bars — this is the PRIMARY trend basis; perp-venue candles are secondary):
- Close ${fmt(ctx.close)} | EMA 20d ${fmt(ctx.ema20)} | 50d ${fmt(ctx.ema50)} | 200d ${fmt(ctx.ema200)} → stack **${stackLabel}**
- vs 50d: ${fmtSigned(ctx.vsEma50Pct)} | vs 200d: ${fmtSigned(ctx.vsEma200Pct)} | 52w high: ${fmt(ctx.high52w)} (${fmtSigned(ctx.pctFrom52wHigh)} from high)
- Momentum: 1m ${fmtSigned(ctx.ret1mPct)} | 3m ${fmtSigned(ctx.ret3mPct)} | realized vol (20d, ann.): ${fmt(ctx.realizedVol20dPct, 1)}%${rs}`;
}
