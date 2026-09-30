/**
 * CoinAnk Plan 2 → the same MarketData shape CoinGlass produces.
 *
 * Plan 2 covers perp/spot klines, aggregated OI, OI-weighted funding,
 * aggregated liquidations, coin-level taker buy/sell dollars, an RSI map,
 * and paginated Hyperliquid whale positions. It does not include spot taker
 * volume (that is Plan 3), so spot confirmation stays neutral.
 *
 * Pace is 950ms (~64 req/min) under the Plan 2 cap of 80. One shared pacer
 * covers per-coin pulls and the cached RSI / whale calls.
 *
 * No CoinGlass URLs in this file.
 */
import type { FuturesBar, OptionsBar, SpotBar } from '../brain/computeScalperFlags.js';
import type { CoinglassMarketData } from './coinglass.js';
import { barIntervalMsOf, type BarInterval } from './coinglass.js';
import type { WhalePos } from './hlWhales.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';
import { config } from '../config.js';

const BASE = 'https://open-api.coinank.com';
/** ~64 req/min, leaving headroom under the Plan 2 cap of 80. */
const PACE_MS = 950;
const SERIES_SIZE = '400';
const VENUES = ['Binance', 'OKX', 'Bybit', 'Bitget', 'Gate'] as const;

const RSI_TTL_MS = 30 * 60 * 1000;
const WHALE_TTL_MS = 20 * 60 * 1000;
const WHALE_PAGE_SIZE = 50;
const WHALE_MAX_PAGES = 4;

let lastCallAt = 0;
let paceChain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial queue. Concurrent callers (RSI intervals, symbol loop) cannot overlap. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = paceChain.then(async () => {
    const wait = lastCallAt === 0 ? 0 : Math.max(0, PACE_MS - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  paceChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function num(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface AnkBody {
  success?: boolean;
  code?: string | number;
  msg?: string;
  data?: unknown;
}

function unwrap(body: AnkBody): unknown {
  const d = body.data;
  if (
    d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    'data' in d &&
    ('success' in d || 'code' in d)
  ) {
    return (d as AnkBody).data;
  }
  return d;
}

async function ankGet(path: string, apiKey: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await paced(() =>
    fetch(`${BASE}${path}?${qs}`, {
      headers: { apikey: apiKey, accept: 'application/json' },
    }),
  );
  if (!res.ok) throw new Error(`CoinAnk ${path} HTTP ${res.status}`);
  const body = (await res.json()) as AnkBody;
  const ok = body.success === true || String(body.code ?? '') === '1';
  if (!ok) {
    throw new Error(`CoinAnk ${path} error: ${body.msg ?? body.code ?? 'unknown'}`);
  }
  return unwrap(body);
}

/** One lightweight kline. Used so a dead key fails the cycle before any symbol work. */
export async function probeCoinankKey(apiKey: string): Promise<boolean> {
  if (!apiKey.trim()) return false;
  try {
    await ankGet('/api/kline/lists', apiKey, {
      symbol: 'BTCUSDT',
      exchange: 'Binance',
      interval: '1h',
      size: '1',
      productType: 'SWAP',
      endTime: String(Date.now()),
    });
    return true;
  } catch (err) {
    console.warn(
      '[coinank] key probe failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export async function probeCoinankKeyWithRetry(apiKey: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (await probeCoinankKey(apiKey)) {
      if (attempt > 1) console.warn(`[coinank] key probe recovered on attempt ${attempt}/2`);
      return true;
    }
    if (attempt < 2) {
      console.warn('[coinank] key probe failed — retry 2/2 in 10s');
      await sleep(10_000);
    }
  }
  return false;
}

interface KlineBar {
  ts: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  turnover?: number;
}

function parseKlines(data: unknown): KlineBar[] {
  if (!Array.isArray(data)) return [];
  const out: KlineBar[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const ts = num(row[0]);
    if (ts == null) continue;
    out.push({
      ts,
      open: num(row[2]),
      close: num(row[3]),
      high: num(row[4]),
      low: num(row[5]),
      turnover: num(row[7]),
    });
  }
  return out;
}

async function kline(
  apiKey: string,
  args: { symbol: string; exchange: string; interval: BarInterval; productType: 'SWAP' | 'SPOT' },
): Promise<KlineBar[]> {
  const data = await ankGet('/api/kline/lists', apiKey, {
    symbol: args.symbol,
    exchange: args.exchange,
    interval: args.interval,
    size: SERIES_SIZE,
    productType: args.productType,
    endTime: String(Date.now()),
  });
  return parseKlines(data);
}

interface VenueHit {
  exchange: string;
  symbol: string;
  rows: KlineBar[];
}

async function firstVenue(
  apiKey: string,
  coin: string,
  interval: BarInterval,
  productType: 'SWAP' | 'SPOT',
  preferred: string | null,
): Promise<VenueHit | null> {
  const symbol = `${coin}USDT`;
  const order = preferred
    ? [preferred, ...VENUES.filter((v) => v !== preferred)]
    : [...VENUES];
  for (const exchange of order) {
    try {
      const rows = await kline(apiKey, { symbol, exchange, interval, productType });
      if (rows.length > 0) return { exchange, symbol, rows };
    } catch (err) {
      console.warn(
        `[coinank] kline ${productType} ${exchange}/${symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return null;
}

interface Point {
  ts: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

function parseObjects(data: unknown, tsKey: string): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row) => row && typeof row === 'object' && tsKey in (row as object)) as Record<
    string,
    unknown
  >[];
}

async function seriesWithCoin(
  path: string,
  apiKey: string,
  coin: string,
  interval: BarInterval,
  extra: Record<string, string> = {},
): Promise<unknown> {
  const base = {
    interval,
    size: SERIES_SIZE,
    endTime: String(Date.now()),
    ...extra,
  };
  const bare = await ankGet(path, apiKey, { ...base, baseCoin: coin });
  if (Array.isArray(bare) && bare.length > 0) return bare;
  if (bare && typeof bare === 'object' && !Array.isArray(bare)) {
    const obj = bare as Record<string, unknown>;
    const hasArrays =
      Array.isArray(obj.tss) || Array.isArray(obj.longRatios) || Array.isArray(obj.timeList);
    if (hasArrays) return bare;
  }
  // A few Plan 1 examples use BTCUSDT as baseCoin. Only pay the extra call on an empty body.
  return ankGet(path, apiKey, { ...base, baseCoin: `${coin}USDT` });
}

function parseOi(data: unknown): Point[] {
  return parseObjects(data, 'begin').flatMap((row) => {
    const ts = num(row.begin);
    if (ts == null) return [];
    return [{ ts, open: num(row.open), high: num(row.high), low: num(row.low), close: num(row.close) }];
  });
}

function parseFunding(data: unknown): { ts: number; rate?: number }[] {
  return parseObjects(data, 'ts').flatMap((row) => {
    const ts = num(row.ts);
    if (ts == null) return [];
    const raw = num(row.openFundingRate);
    // Brain multiplies funding_rate by 10_000 to get bps, so this must be a
    // decimal (0.0001 = 1 bp). Values above 1 are not a per-interval decimal.
    let rate = raw;
    if (rate != null && Math.abs(rate) > 1) rate = rate / 100;
    return [{ ts, rate }];
  });
}

function parseLiq(data: unknown): { ts: number; longUsd?: number; shortUsd?: number }[] {
  return parseObjects(data, 'ts').flatMap((row) => {
    const ts = num(row.ts);
    if (ts == null) return [];
    const all = row.all;
    if (!all || typeof all !== 'object') return [{ ts }];
    const bag = all as Record<string, unknown>;
    return [{ ts, longUsd: num(bag.longTurnover), shortUsd: num(bag.shortTurnover) }];
  });
}

function parseBuySell(data: unknown): { ts: number; buy?: number; sell?: number }[] | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const bag = data as Record<string, unknown>;
  const tss = bag.tss;
  const buys = bag.longRatios;
  const sells = bag.shortRatios;
  if (!Array.isArray(tss) || !Array.isArray(buys) || !Array.isArray(sells)) return null;
  const out: { ts: number; buy?: number; sell?: number }[] = [];
  const magnitudes: number[] = [];
  const n = Math.min(tss.length, buys.length, sells.length);
  for (let i = 0; i < n; i += 1) {
    const ts = num(tss[i]);
    const buy = num(buys[i]);
    const sell = num(sells[i]);
    if (ts == null) continue;
    if (buy != null) magnitudes.push(Math.abs(buy));
    if (sell != null) magnitudes.push(Math.abs(sell));
    out.push({ ts, buy, sell });
  }
  const peak = magnitudes.length ? Math.max(...magnitudes) : 0;
  // Published sample is dollar-sized (1e8). A 0–1 ratio must not be treated as USD.
  if (peak > 0 && peak < 100) return null;
  return out;
}

function bucket(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

/**
 * Full crypto series for one HL coin. Returns null when no perp kline exists
 * (the symbol soft-skips). Spot taker fields are left unset on purpose.
 */
export async function fetchCoinankMarketData(args: {
  hlCoin: string;
  apiKey: string;
  optionsBars?: OptionsBar[];
  interval?: BarInterval;
  swapVenue?: string | null;
  spotVenue?: string | null;
  /** 24h memo: do not spend a venue walk on a coin that has no spot listing. */
  skipSpot?: boolean;
}): Promise<{ data: CoinglassMarketData | null; swapVenue: string | null; spotVenue: string | null; spotMiss: boolean }> {
  const coin = args.hlCoin.toUpperCase();
  const interval = args.interval ?? '1h';
  const intervalMs = barIntervalMsOf(interval);
  const key = args.apiKey;

  const swap = await firstVenue(key, coin, interval, 'SWAP', args.swapVenue ?? null);
  if (!swap) {
    console.warn(`[coinank] ${coin}: no perp kline on any venue — soft skip`);
    return { data: null, swapVenue: null, spotVenue: args.spotVenue ?? null, spotMiss: false };
  }

  let spotVenue = args.spotVenue ?? null;
  let spotRows: KlineBar[] = [];
  let spotMiss = false;
  if (!args.skipSpot) {
    const spot = await firstVenue(key, coin, interval, 'SPOT', spotVenue);
    if (spot) {
      spotRows = spot.rows;
      spotVenue = spot.exchange;
    } else {
      spotVenue = null;
      spotMiss = true;
      console.log(`[coinank] ${coin}: no spot kline — premium skipped for 24h`);
    }
  }

  let oi: Point[] = [];
  let funding: { ts: number; rate?: number }[] = [];
  let liq: { ts: number; longUsd?: number; shortUsd?: number }[] = [];
  let flow: { ts: number; buy?: number; sell?: number }[] | null = [];

  try {
    oi = parseOi(await seriesWithCoin('/api/openInterest/aggKline', key, coin, interval));
  } catch (err) {
    console.warn(`[coinank] ${coin} OI skipped:`, err instanceof Error ? err.message : err);
  }
  try {
    funding = parseFunding(await seriesWithCoin('/api/fundingRate/getWeiFr', key, coin, interval));
  } catch (err) {
    console.warn(`[coinank] ${coin} funding skipped:`, err instanceof Error ? err.message : err);
  }
  try {
    liq = parseLiq(await seriesWithCoin('/api/liquidation/aggregated-history', key, coin, interval));
  } catch (err) {
    console.warn(`[coinank] ${coin} liquidations skipped:`, err instanceof Error ? err.message : err);
  }
  try {
    const raw = await seriesWithCoin('/api/longshort/buySell', key, coin, interval);
    flow = parseBuySell(raw);
    if (flow == null) {
      console.warn(`[coinank] ${coin} taker buy/sell looks like a ratio, not dollars — flow left empty`);
      flow = [];
    }
  } catch (err) {
    console.warn(`[coinank] ${coin} taker flow skipped:`, err instanceof Error ? err.message : err);
    flow = [];
  }

  const futBars = new Map<number, FuturesBar>();
  const bar = (t: number): FuturesBar => {
    const keyTs = bucket(t, intervalMs);
    let b = futBars.get(keyTs);
    if (!b) {
      b = { timestamp: keyTs };
      futBars.set(keyTs, b);
    }
    return b;
  };

  for (const r of swap.rows) {
    const b = bar(r.ts);
    b.open_price = r.open;
    b.high_price = r.high;
    b.low_price = r.low;
    b.close_price = r.close;
    b.dollar_volume = r.turnover;
  }
  for (const r of oi) {
    const b = bar(r.ts);
    b.dollar_open_interest_close = r.close;
    b.dollar_open_interest_high = r.high;
    b.dollar_open_interest_low = r.low;
  }
  for (const r of funding) {
    if (r.rate != null) bar(r.ts).funding_rate = r.rate;
  }
  for (const r of liq) {
    const b = bar(r.ts);
    // Same Velo mapping as CoinGlass: short liquidations are forced buys.
    b.buy_liquidations_dollar_volume = r.shortUsd;
    b.sell_liquidations_dollar_volume = r.longUsd;
    b.liquidations_dollar_volume = (r.shortUsd ?? 0) + (r.longUsd ?? 0);
  }
  for (const r of flow) {
    const b = bar(r.ts);
    b.buy_dollar_volume = r.buy;
    b.sell_dollar_volume = r.sell;
  }

  const spotBars = new Map<number, SpotBar>();
  for (const r of spotRows) {
    const keyTs = bucket(r.ts, intervalMs);
    const b = spotBars.get(keyTs) ?? { timestamp: keyTs };
    b.close_price = r.close;
    b.dollar_volume = r.turnover;
    spotBars.set(keyTs, b);
  }
  for (const [t, fb] of futBars) {
    const sp = spotBars.get(t)?.close_price as number | undefined;
    if (fb.close_price != null && sp != null && sp > 0) {
      fb.premium = ((fb.close_price - sp) / sp) * 10_000;
    }
  }

  const sort = <T extends { timestamp: number }>(m: Map<number, T>): T[] =>
    [...m.values()].sort((a, b) => a.timestamp - b.timestamp);

  const futuresSeries = sort(futBars);
  if (futuresSeries.length === 0) {
    return { data: null, swapVenue: swap.exchange, spotVenue, spotMiss };
  }

  console.log(`[coinank] ${coin} perp kline via ${swap.exchange}/${swap.symbol}`);
  return {
    data: {
      symbol: coin,
      fetchedAt: new Date().toISOString(),
      barIntervalMs: intervalMs,
      futures: { timeSeries: futuresSeries },
      spot: { timeSeries: sort(spotBars) },
      options: { timeSeries: args.optionsBars ?? [] },
    },
    swapVenue: swap.exchange,
    spotVenue,
    spotMiss,
  };
}

interface RsiHit {
  rsi1h: number | null;
  rsi4h: number | null;
  rsi1d: number | null;
}

function pairBase(pair: string): string {
  const p = pair.toUpperCase().replace(/[-_]/g, '');
  if (p.endsWith('USDT')) return p.slice(0, -4);
  if (p.endsWith('USD')) return p.slice(0, -3);
  return p;
}

async function fetchRsiInterval(apiKey: string, interval: '1H' | '4H' | '24H'): Promise<Map<string, number>> {
  const data = await ankGet('/api/rsiMap/list', apiKey, { interval, exchange: 'Binance' });
  const out = new Map<string, number>();
  if (!data || typeof data !== 'object') return out;
  const rows = (data as { rsiMap?: unknown }).rsiMap;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const base = pairBase(String(row[0] ?? ''));
    const rsi = num(row[1]);
    if (!base || rsi == null) continue;
    out.set(base, rsi);
  }
  return out;
}

async function produceRsi(apiKey: string): Promise<Record<string, RsiHit>> {
  const h1 = await fetchRsiInterval(apiKey, '1H');
  const h4 = await fetchRsiInterval(apiKey, '4H');
  const d1 = await fetchRsiInterval(apiKey, '24H');
  const coins = new Set<string>([...h1.keys(), ...h4.keys(), ...d1.keys()]);
  const out: Record<string, RsiHit> = {};
  for (const coin of coins) {
    out[coin] = {
      rsi1h: h1.get(coin) ?? null,
      rsi4h: h4.get(coin) ?? null,
      rsi1d: d1.get(coin) ?? null,
    };
  }
  return out;
}

export async function getCoinankRsiContext(
  hlCoin: string,
): Promise<{ rsi1h: number | null; rsi4h: number | null; rsi1d: number | null } | null> {
  const apiKey = config.coinankApiKey;
  if (!config.coinankMode || !apiKey) return null;
  const map = await getOrRefreshGlobalContext<Record<string, RsiHit>>({
    key: 'coinank_rsi_map_v1',
    ttlMs: RSI_TTL_MS,
    produce: () => produceRsi(apiKey),
  });
  if (!map) return null;
  return map[hlCoin.toUpperCase()] ?? null;
}

interface AnkWhale {
  baseCoin?: string;
  side?: string;
  positionValue?: number | string;
  liquidationPx?: number | string;
  leverage?: number | string;
  state?: number | string;
}

async function produceWhales(apiKey: string): Promise<WhalePos[]> {
  const out: WhalePos[] = [];
  for (let page = 1; page <= WHALE_MAX_PAGES; page += 1) {
    const data = await ankGet('/api/hyper/topPosition', apiKey, {
      sortBy: 'positionValue',
      sortType: 'desc',
      page: String(page),
      size: String(WHALE_PAGE_SIZE),
    });
    const list = (data && typeof data === 'object' ? (data as { list?: AnkWhale[] }).list : null) ?? [];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const row of list) {
      // 1 = open, 2 = close. Closed rows are not a live cluster.
      if (String(row.state ?? '1') === '2') continue;
      const sym = String(row.baseCoin ?? '').toUpperCase();
      const value = Number(row.positionValue);
      if (!sym || !Number.isFinite(value) || value <= 0) continue;
      const sideRaw = String(row.side ?? '').toLowerCase();
      const liq = Number(row.liquidationPx);
      const lev = Number(row.leverage);
      out.push({
        symbol: sym,
        side: sideRaw.startsWith('short') ? -1 : 1,
        valueUsd: value,
        liqPrice: Number.isFinite(liq) && liq > 0 ? liq : null,
        leverage: Number.isFinite(lev) && lev > 0 ? lev : null,
      });
    }
    if (list.length < WHALE_PAGE_SIZE) break;
  }
  return out;
}

/** Plan 2 whale pages, cached. Callers on the CoinGlass path must not use this. */
export async function getCoinankWhalePositions(): Promise<WhalePos[] | null> {
  const apiKey = config.coinankApiKey;
  if (!config.coinankMode || !apiKey) return null;
  return getOrRefreshGlobalContext<WhalePos[]>({
    key: 'coinank_hl_whales_v1',
    ttlMs: WHALE_TTL_MS,
    produce: () => produceWhales(apiKey),
  });
}
