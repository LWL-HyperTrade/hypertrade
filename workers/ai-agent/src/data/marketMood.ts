/**
 * Slow market-mood context — two one-liners for the OPENING prompt only
 * (daily-cadence signals; monitors don't need them):
 *   • Crypto Fear & Greed index (/api/index/fear-greed-history)
 *   • Stablecoin market cap trend — CoinGlass first, DefiLlama fallback
 *     — rising stables = dry powder building; falling = deployment/outflow.
 * Globally cached 6h. Deliberately minimal to save prompt tokens.
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

export interface MarketMoodContext {
  fearGreed: number | null; // 0..100
  fearGreedPrev7d: number | null;
  stablecoinMcapUsd: number | null;
  stablecoinMcap30dChangePct: number | null;
  updatedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
/** Retry sooner when one series is still missing (don't lock a half-empty row for 6h). */
const PARTIAL_TTL_MS = 30 * 60 * 1000;

function moodTtlMs(ctx: MarketMoodContext): number {
  if (ctx.fearGreed == null || ctx.stablecoinMcapUsd == null || ctx.stablecoinMcap30dChangePct == null) {
    return PARTIAL_TTL_MS;
  }
  return TTL_MS;
}

type SeriesPoint = {
  data_list?: (number | string)[];
  price_list?: (number | string)[];
  time_list?: (number | string)[];
  value?: number | string;
  marketCap?: number | string;
  market_cap?: number | string;
  mcap?: number | string;
  t?: number | string;
  timestamp?: number | string;
};

interface SeriesResp {
  code?: string;
  msg?: string;
  data?: SeriesPoint[] | SeriesPoint | (number | string)[][];
}

function asFiniteNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function describeShape(data: SeriesResp['data']): string {
  if (data == null) return 'null';
  if (Array.isArray(data)) {
    if (data.length === 0) return 'array(0)';
    const first = data[0] as unknown;
    if (Array.isArray(first)) return `array(${data.length}) of tuples len=${first.length}`;
    if (first && typeof first === 'object') {
      const keys = Object.keys(first as object).slice(0, 12).join(',');
      return `array(${data.length}) objectKeys=[${keys}]`;
    }
    return `array(${data.length}) of ${typeof first}`;
  }
  if (typeof data === 'object') {
    return `objectKeys=[${Object.keys(data).slice(0, 12).join(',')}]`;
  }
  return typeof data;
}

/** Pull a numeric series from either CoinGlass response shape. */
function extractSeries(data: SeriesResp['data'], valueKeys: string[]): number[] {
  if (data == null) return [];

  // Tuple rows: [[t, value], ...] or [t, value] nested under data
  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
    const out: number[] = [];
    for (const row of data as unknown as unknown[][]) {
      if (!Array.isArray(row) || row.length < 2) continue;
      // Prefer last numeric cell (value); first is usually timestamp.
      let v: number | null = null;
      for (let i = row.length - 1; i >= 0; i--) {
        const n = asFiniteNumber(row[i]);
        if (n != null) {
          v = n;
          break;
        }
      }
      if (v != null) out.push(v);
    }
    return out;
  }

  // Point array first — CoinGlass v4 migrated several index endpoints to
  // [{ value|marketCap, t }, ...]. Check this BEFORE legacy data_list so a
  // stray empty data_list on a point object can't short-circuit us.
  if (Array.isArray(data)) {
    const looksLikePoints = data.some(
      (row) =>
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        valueKeys.some((k) => (row as Record<string, unknown>)[k] != null),
    );
    if (looksLikePoints) {
      const out: number[] = [];
      for (const row of data) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        let v: number | null = null;
        for (const k of valueKeys) {
          v = asFiniteNumber((row as Record<string, unknown>)[k]);
          if (v != null) break;
        }
        if (v != null) out.push(v);
      }
      if (out.length) return out;
    }
  }

  // Legacy parallel-array: { data_list|price_list, time_list } (sometimes wrapped in [])
  const legacyBlock = (Array.isArray(data) ? data[0] : data) as SeriesPoint | undefined;
  if (legacyBlock && typeof legacyBlock === 'object' && !Array.isArray(legacyBlock)) {
    for (const listKey of ['data_list', 'price_list'] as const) {
      const list = legacyBlock[listKey];
      if (!Array.isArray(list) || list.length === 0) continue;
      const nums = list.map(asFiniteNumber).filter((n): n is number => n != null);
      if (nums.length) return nums;
    }
  }

  // Last resort: any numeric field on point rows (except timestamps).
  if (Array.isArray(data)) {
    const skip = new Set(['t', 'timestamp', 'time', 'date']);
    const out: number[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      let v: number | null = null;
      for (const [k, raw] of Object.entries(row as Record<string, unknown>)) {
        if (skip.has(k)) continue;
        v = asFiniteNumber(raw);
        if (v != null) break;
      }
      if (v != null) out.push(v);
    }
    return out;
  }

  return [];
}

async function fetchSeries(path: string, apiKey: string, valueKeys: string[]): Promise<number[]> {
  const res = await fetch(`https://open-api-v4.coinglass.com${path}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${path} HTTP ${res.status}`);
  const body = (await res.json()) as SeriesResp;
  if (body.code !== '0') throw new Error(`CoinGlass ${path}: ${body.msg ?? body.code}`);
  const list = extractSeries(body.data, valueKeys);
  if (list.length === 0) {
    throw new Error(`CoinGlass ${path}: empty series (${describeShape(body.data)})`);
  }
  return list;
}

/**
 * DefiLlama stablecoin circulating USD — free, daily. Used when CoinGlass
 * stablecoin history fails or returns an unrecognized shape.
 */
async function fetchStablecoinMcapDefiLlama(): Promise<number[]> {
  const res = await fetch('https://stablecoins.llama.fi/stablecoincharts/all', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DefiLlama stables HTTP ${res.status}`);
  const body = (await res.json()) as Array<{
    totalCirculatingUSD?: { peggedUSD?: number | string };
  }>;
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('DefiLlama stables: empty series');
  }
  const list = body
    .map((row) => asFiniteNumber(row?.totalCirculatingUSD?.peggedUSD))
    .filter((n): n is number => n != null);
  if (list.length === 0) throw new Error('DefiLlama stables: no peggedUSD points');
  return list;
}

async function produce(apiKey: string): Promise<MarketMoodContext> {
  const [fgSettled, stablesSettled] = await Promise.allSettled([
    fetchSeries('/api/index/fear-greed-history', apiKey, ['value']),
    fetchSeries('/api/index/stableCoin-marketCap-history', apiKey, [
      'marketCap',
      'market_cap',
      'mcap',
      'value',
    ]),
  ]);

  const fg = fgSettled.status === 'fulfilled' ? fgSettled.value : [];
  let stables = stablesSettled.status === 'fulfilled' ? stablesSettled.value : [];
  if (fgSettled.status === 'rejected') {
    console.warn(
      '[marketMood] fear-greed failed:',
      fgSettled.reason instanceof Error ? fgSettled.reason.message : fgSettled.reason,
    );
  }
  if (stablesSettled.status === 'rejected') {
    console.warn(
      '[marketMood] CoinGlass stablecoin mcap failed:',
      stablesSettled.reason instanceof Error
        ? stablesSettled.reason.message
        : stablesSettled.reason,
    );
  }

  if (stables.length === 0) {
    try {
      stables = await fetchStablecoinMcapDefiLlama();
      console.log(`[marketMood] stablecoin mcap via DefiLlama (${stables.length} points)`);
    } catch (err) {
      console.warn(
        '[marketMood] DefiLlama stablecoin mcap failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const last = (a: number[]) => (a.length ? a[a.length - 1] : null);
  const ago = (a: number[], n: number) => (a.length > n ? a[a.length - 1 - n] : null);

  const scLast = last(stables);
  const sc30 = ago(stables, 30);
  const ctx: MarketMoodContext = {
    fearGreed: last(fg),
    fearGreedPrev7d: ago(fg, 7),
    stablecoinMcapUsd: scLast,
    stablecoinMcap30dChangePct:
      scLast != null && sc30 != null && sc30 > 0 ? ((scLast - sc30) / sc30) * 100 : null,
    updatedAt: new Date().toISOString(),
  };

  // Don't lock a useless all-null row into the cache — retry next cycle.
  if (ctx.fearGreed == null && ctx.stablecoinMcapUsd == null) {
    throw new Error('market mood: both series empty');
  }
  return ctx;
}

export async function getMarketMood(): Promise<MarketMoodContext | null> {
  if (config.coinankMode) {
    return getOrRefreshGlobalContext<MarketMoodContext | null>({
      key: 'market_mood_defillama_v1',
      ttlMs: TTL_MS,
      produce: async () => {
        const stables = await fetchStablecoinMcapDefiLlama();
        const last = (a: number[]) => (a.length ? a[a.length - 1] : null);
        const ago = (a: number[], n: number) => (a.length > n ? a[a.length - 1 - n] : null);
        const scLast = last(stables);
        const sc30 = ago(stables, 30);
        if (scLast == null) throw new Error('market mood: stablecoin mcap empty');
        return {
          fearGreed: null,
          fearGreedPrev7d: null,
          stablecoinMcapUsd: scLast,
          stablecoinMcap30dChangePct:
            sc30 != null && sc30 > 0 ? ((scLast - sc30) / sc30) * 100 : null,
          updatedAt: new Date().toISOString(),
        };
      },
    });
  }
  const key = config.coinglassHouseKey;
  if (!key) return null;
  return getOrRefreshGlobalContext<MarketMoodContext | null>({
    key: 'market_mood_v1',
    ttlMs: TTL_MS,
    ttlMsForValue: (v) => (v ? moodTtlMs(v) : TTL_MS),
    produce: () => produce(key),
  });
}

function fgLabel(v: number): string {
  if (v <= 20) return 'EXTREME FEAR';
  if (v <= 40) return 'fear';
  if (v <= 60) return 'neutral';
  if (v <= 80) return 'greed';
  return 'EXTREME GREED';
}

/** Two lines max. Empty string when unavailable. */
export function renderMarketMoodSection(ctx: MarketMoodContext | null | undefined): string {
  if (!ctx || (ctx.fearGreed == null && ctx.stablecoinMcap30dChangePct == null)) return '';
  const lines: string[] = [];
  if (ctx.fearGreed != null) {
    const delta =
      ctx.fearGreedPrev7d != null ? ` (7d ago: ${Math.round(ctx.fearGreedPrev7d)})` : '';
    lines.push(`- Fear & Greed: ${Math.round(ctx.fearGreed)} — ${fgLabel(ctx.fearGreed)}${delta}`);
  }
  if (ctx.stablecoinMcapUsd != null && ctx.stablecoinMcap30dChangePct != null) {
    const dir = ctx.stablecoinMcap30dChangePct >= 0 ? 'growing' : 'shrinking';
    lines.push(
      `- Stablecoin mcap: $${(ctx.stablecoinMcapUsd / 1e9).toFixed(0)}B, ${dir} ${ctx.stablecoinMcap30dChangePct >= 0 ? '+' : ''}${ctx.stablecoinMcap30dChangePct.toFixed(1)}% over 30d (${ctx.stablecoinMcap30dChangePct >= 0 ? 'dry powder building' : 'liquidity draining'})`,
    );
  }
  return `

**MARKET MOOD (daily context)**:
${lines.join('\n')}`;
}
