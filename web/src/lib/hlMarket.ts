/** Public Hyperliquid market data — no signing, no builder, no Privy. */

import { aggregateDailyToCalendarMonths, aggregateDailyToCalendarWeeks } from './calendarBars';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';

export type BookLevel = { px: number; sz: number; n: number };
export type L2Book = { coin: string; time: number; bids: BookLevel[]; asks: BookLevel[] };

export type TapeTrade = {
  coin: string;
  side: 'B' | 'A';
  px: number;
  sz: number;
  time: number;
  key: string;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type AssetCtx = {
  markPx: number | null;
  midPx: number | null;
  prevDayPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
};

export type SpotBalance = {
  coin: string;
  total: number;
  hold: number;
  entryNtl: number | null;
};

export type Clearinghouse = {
  accountValue: number | null;
  withdrawable: number | null;
  totalMarginUsed: number | null;
  /** Sum of cross MM used across dex pools (for liq estimates). */
  crossMaintenanceMarginUsed: number | null;
  /** USDC in `spotClearinghouseState` — HL source of truth in unified / portfolio margin. */
  spotUsdc: number | null;
  /** Raw perp dex account value (not rewritten to spot on unified). */
  perpAccountValue: number | null;
  perpWithdrawable: number | null;
  spotBalances: SpotBalance[];
  abstractionMode: string | null;
  positions: Array<{
    coin: string;
    szi: number;
    entryPx: number | null;
    leverage: number | null;
    marginType: 'cross' | 'isolated';
    unrealizedPnl: number | null;
    liquidationPx: number | null;
    marginUsed: number | null;
    positionValue: number | null;
    returnOnEquity: number | null;
    cumFundingSinceOpen: number | null;
  }>;
};

/** Same default dex list as `frontend/src/lib/hip3Dexes.ts`. */
export const HIP3_DEXES = ['xyz', 'io'] as const;

type ClearinghouseRaw = {
  marginSummary?: { accountValue?: unknown; totalMarginUsed?: unknown };
  crossMaintenanceMarginUsed?: unknown;
  withdrawable?: unknown;
  assetPositions?: Array<{
    position?: {
      coin?: string;
      szi?: unknown;
      entryPx?: unknown;
      leverage?: { value?: unknown; type?: string } | unknown;
      unrealizedPnl?: unknown;
      liquidationPx?: unknown;
      marginUsed?: unknown;
      positionValue?: unknown;
      returnOnEquity?: unknown;
      cumFunding?: { allTime?: unknown; sinceOpen?: unknown; sinceChange?: unknown };
    };
  }>;
};

type SpotClearinghouseRaw = {
  balances?: Array<{
    coin?: string;
    token?: number;
    total?: unknown;
    hold?: unknown;
    entryNtl?: unknown;
  }>;
};

function isPooledAccountMode(mode: string | null | undefined): boolean {
  return mode === 'unifiedAccount' || mode === 'portfolioMargin';
}

export function parseSpotBalances(spot: SpotClearinghouseRaw | null | undefined): SpotBalance[] {
  if (!spot?.balances) return [];
  const out: SpotBalance[] = [];
  for (const b of spot.balances) {
    const coin = String(b.coin ?? '').trim();
    if (!coin) continue;
    const total = num(b.total) ?? 0;
    const hold = num(b.hold) ?? 0;
    const entryNtl = num(b.entryNtl);
    if (total <= 0 && hold <= 0) continue;
    out.push({
      coin,
      total,
      hold,
      entryNtl: entryNtl != null && Number.isFinite(entryNtl) ? entryNtl : null,
    });
  }
  return out;
}

export function isSpotBookCoin(coin: string): boolean {
  return coin.includes('/') || coin.startsWith('@');
}

/** Same as `computeSpotUsdcOnlyUsd` in `frontend/src/lib/hyperliquid.ts`. */
export function spotUsdcFromState(spot: SpotClearinghouseRaw | null | undefined): number {
  if (!spot?.balances) return 0;
  let total = 0;
  for (const b of spot.balances) {
    const coin = String(b.coin ?? '').toUpperCase();
    const isUsdc = coin === 'USDC' || b.token === 0;
    if (!isUsdc) continue;
    const v = num(b.total) ?? 0;
    if (v > 0) total += v;
  }
  return total;
}

function parsePositions(
  raw: ClearinghouseRaw | null | undefined,
  dex = '',
): Clearinghouse['positions'] {
  return (raw?.assetPositions ?? [])
    .map((row) => {
      const p = row.position ?? {};
      const levObj = p.leverage;
      const lev =
        levObj && typeof levObj === 'object'
          ? num((levObj as { value?: unknown }).value)
          : num(levObj);
      const marginType: 'cross' | 'isolated' =
        levObj && typeof levObj === 'object' && (levObj as { type?: string }).type === 'isolated'
          ? 'isolated'
          : 'cross';
      // HIP-3 clearinghouse often returns bare coin (e.g. CL); catalog +
      // trading paths expect dex:coin (xyz:CL) — same as open orders.
      let coin = String(p.coin ?? '');
      if (dex && coin && !coin.includes(':')) coin = `${dex}:${coin}`;
      return {
        coin,
        szi: num(p.szi) ?? 0,
        entryPx: num(p.entryPx),
        leverage: lev,
        marginType,
        unrealizedPnl: num(p.unrealizedPnl),
        liquidationPx: num(p.liquidationPx),
        marginUsed: num(p.marginUsed),
        positionValue: num(p.positionValue),
        returnOnEquity: num(p.returnOnEquity),
        cumFundingSinceOpen: num(p.cumFunding?.sinceOpen),
      };
    })
    .filter((p) => p.coin && p.szi !== 0);
}

function isolatedMarginUsed(raw: ClearinghouseRaw | null | undefined): number {
  let sum = 0;
  for (const row of raw?.assetPositions ?? []) {
    const lev = row.position?.leverage;
    const isolated = typeof lev === 'object' && lev != null && (lev as { type?: string }).type === 'isolated';
    if (!isolated) continue;
    sum += num(row.position?.marginUsed) ?? 0;
  }
  return sum;
}

export type OpenOrder = {
  coin: string;
  side: 'B' | 'A';
  limitPx: number;
  sz: number;
  origSz: number;
  oid: number;
  timestamp: number;
  orderType: string;
  reduceOnly: boolean;
  isTrigger: boolean;
  triggerPx: number | null;
  tpsl: 'tp' | 'sl' | null;
  isPositionTpsl: boolean;
  cloid: string | null;
};

/**
 * Resting limits, or position-linked TP/SL (s='0'). Sized stop/take entry
 * orders can be cancelled but not edited — modify currently re-places
 * triggers as positionTpsl.
 */
export function isEditableOpenOrder(o: OpenOrder): boolean {
  const type = (o.orderType || '').toLowerCase();
  const triggerPx = o.triggerPx;
  const isPosTpsl =
    o.isPositionTpsl || ((o.tpsl === 'tp' || o.tpsl === 'sl') && !(o.sz > 0));
  if (isPosTpsl) {
    return triggerPx != null && Number.isFinite(triggerPx) && triggerPx > 0;
  }
  const isStandaloneTrigger =
    o.isTrigger ||
    o.tpsl === 'tp' ||
    o.tpsl === 'sl' ||
    /stop|take|trigger/.test(type) ||
    (triggerPx != null && Number.isFinite(triggerPx) && triggerPx > 0);
  if (isStandaloneTrigger) return false;
  return (
    Number.isFinite(o.limitPx) &&
    o.limitPx > 0 &&
    (type === '' || type.includes('limit'))
  );
}

/** HL candleSnapshot / WS candle intervals (docs + info endpoint). */
export const ALL_CANDLE_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;

export type CandleInterval = (typeof ALL_CANDLE_INTERVALS)[number];

/** Default toolbar set — full list is toggleable via chart prefs. */
export const DEFAULT_VISIBLE_INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function intervalLabel(id: CandleInterval): string {
  if (id === '1w') return 'W';
  if (id === '1M') return 'M';
  return id;
}

export function dexFromCoin(coin: string): string | null {
  const i = coin.indexOf(':');
  return i > 0 ? coin.slice(0, i) : null;
}

export function displaySymbol(coin: string, fallback?: string): string {
  if (fallback?.trim()) return fallback.trim();
  const base = coin.includes(':') ? coin.split(':').pop() || coin : coin;
  return base.replace(/^@/, '');
}

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatPx(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 2 : 4 });
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

export function formatSz(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

/** Same gate as mobile `getHyperliquidTradingState` (`accountValueUsd > 0.01 || withdrawableUsd > 0.01`). */
export function hasHlTradeBalance(clearing: Clearinghouse | null | undefined): boolean {
  const account = clearing?.accountValue ?? 0;
  const withdrawable = clearing?.withdrawable ?? 0;
  const spot = clearing?.spotUsdc ?? 0;
  return account > 0.01 || withdrawable > 0.01 || spot > 0.01;
}

export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export function formatFunding(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(4)}%`;
}

/** HL perps fund hourly at the UTC hour boundary. */
export function msUntilNextFunding(now = Date.now()): number {
  const hourMs = 3_600_000;
  return hourMs - (now % hourMs);
}

export function formatFundingCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function change24h(mark: number | null, prev: number | null): number | null {
  if (mark == null || prev == null || !prev) return null;
  return ((mark - prev) / prev) * 100;
}

export async function hlInfo<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return (await res.json()) as T;
}

function parseLevel(row: unknown): BookLevel | null {
  if (Array.isArray(row)) {
    const px = num(row[0]);
    const sz = num(row[1]);
    if (px == null || sz == null) return null;
    return { px, sz, n: num(row[2]) ?? 1 };
  }
  if (row && typeof row === 'object') {
    const r = row as { px?: unknown; sz?: unknown; n?: unknown };
    const px = num(r.px);
    const sz = num(r.sz);
    if (px == null || sz == null) return null;
    return { px, sz, n: num(r.n) ?? 1 };
  }
  return null;
}

export function parseL2Book(raw: unknown, fallbackCoin = ''): L2Book {
  const data = (raw ?? {}) as {
    coin?: string;
    time?: number;
    levels?: [unknown[], unknown[]];
  };
  const bids = (data.levels?.[0] ?? []).map(parseLevel).filter((x): x is BookLevel => !!x);
  const asks = (data.levels?.[1] ?? []).map(parseLevel).filter((x): x is BookLevel => !!x);
  return { coin: data.coin || fallbackCoin, time: data.time ?? Date.now(), bids, asks };
}

/**
 * HL aggregates the book server-side by significant figures (2–5). Omit for
 * the exchange's finest 20 levels per side. This is what the HL UI's "0.01 /
 * 0.1 / 1" grouping menu drives — 20 *grouped* levels, not 20 raw ones.
 */
export function l2BookRequest(coin: string, nSigFigs?: number | null): Record<string, unknown> {
  const req: Record<string, unknown> = { type: 'l2Book', coin };
  if (nSigFigs != null && Number.isFinite(nSigFigs)) {
    req.nSigFigs = Math.max(2, Math.min(5, Math.round(nSigFigs)));
  }
  return req;
}

export async function fetchL2Book(coin: string, nSigFigs?: number | null): Promise<L2Book> {
  const raw = await hlInfo<unknown>(l2BookRequest(coin, nSigFigs));
  return parseL2Book(raw, coin);
}

export async function fetchCandles(coin: string, interval: CandleInterval, lookbackMs: number): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - lookbackMs;
  const raw = await hlInfo<Array<Record<string, unknown>> | string>({
    type: 'candleSnapshot',
    req: { coin, interval, startTime, endTime },
  });
  const rows = typeof raw === 'string' ? (JSON.parse(raw) as Array<Record<string, unknown>>) : raw;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((c) => ({
      t: num(c.t) ?? 0,
      o: num(c.o) ?? 0,
      h: num(c.h) ?? 0,
      l: num(c.l) ?? 0,
      c: num(c.c) ?? 0,
      v: num(c.v) ?? 0,
    }))
    .filter((c) => c.t > 0);
}

/**
 * Chart candles: `1w` / `1M` are rebuilt from `1d` (Monday-UTC weeks, calendar months).
 * HL native `1w` is Thursday-aligned; native `1M` is a fixed 30-day step.
 */
export async function fetchChartCandles(
  coin: string,
  interval: CandleInterval,
  lookback: number,
): Promise<Candle[]> {
  if (interval === '1w') {
    return aggregateDailyToCalendarWeeks(await fetchCandles(coin, '1d', lookback));
  }
  if (interval === '1M') {
    return aggregateDailyToCalendarMonths(await fetchCandles(coin, '1d', lookback));
  }
  return fetchCandles(coin, interval, lookback);
}

export async function fetchAllMids(dex?: string | null): Promise<Record<string, string>> {
  const raw = await hlInfo<Record<string, string>>(dex ? { type: 'allMids', dex } : { type: 'allMids' });
  return raw && typeof raw === 'object' ? raw : {};
}

export function midFor(mids: Record<string, string>, coin: string): number | null {
  const keys = [coin, coin.toUpperCase(), coin.split(':').pop() ?? ''];
  for (const k of keys) {
    if (k && mids[k] != null) return num(mids[k]);
  }
  return null;
}

/** Live mids for a set of coins (main + needed HIP-3 dexes). */
export async function fetchMidsForCoins(coins: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(coins.map((c) => c.trim()).filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;

  const dexes = new Set<string | null>([null]);
  for (const c of unique) {
    const d = dexFromCoin(c);
    if (d) dexes.add(d);
  }

  const byDex = new Map<string | null, Record<string, string>>();
  await Promise.all(
    [...dexes].map(async (dex) => {
      byDex.set(dex, await fetchAllMids(dex));
    }),
  );

  for (const coin of unique) {
    const dex = dexFromCoin(coin);
    const mids = byDex.get(dex) ?? byDex.get(null) ?? {};
    const px = midFor(mids, coin);
    if (px != null && px > 0) out.set(coin, px);
  }
  return out;
}

function parseCtx(raw: unknown): AssetCtx {
  const ctx = (raw ?? {}) as Record<string, unknown>;
  return {
    markPx: num(ctx.markPx),
    midPx: num(ctx.midPx),
    prevDayPx: num(ctx.prevDayPx),
    funding: num(ctx.funding),
    openInterest: num(ctx.openInterest),
    dayNtlVlm: num(ctx.dayNtlVlm),
  };
}

export async function fetchAssetCtx(coin: string, opts?: { spot?: boolean }): Promise<AssetCtx | null> {
  try {
    if (opts?.spot || isSpotBookCoin(coin)) {
      const raw = await hlInfo<[unknown, Array<Record<string, unknown>>]>({
        type: 'spotMetaAndAssetCtxs',
      });
      const ctxs = raw?.[1] ?? [];
      const hit =
        ctxs.find((c) => String(c.coin ?? '').toUpperCase() === coin.toUpperCase()) ?? null;
      return hit ? parseCtx(hit) : null;
    }
    const dex = dexFromCoin(coin);
    if (dex) {
      const raw = await hlInfo<[unknown, Array<{ coin?: string } & Record<string, unknown>>]>({
        type: 'metaAndAssetCtxs',
        dex,
      });
      const ctxs = raw?.[1];
      const meta = raw?.[0] as { universe?: Array<{ name?: string }> } | undefined;
      const names = meta?.universe ?? [];
      const idx = names.findIndex((u) => u.name === coin || u.name === coin.split(':').pop());
      if (idx >= 0 && ctxs?.[idx]) return parseCtx(ctxs[idx]);
      const hit = ctxs?.find((c) => c.coin === coin);
      return hit ? parseCtx(hit) : null;
    }
    const raw = await hlInfo<[unknown, Array<Record<string, unknown>>]>({ type: 'metaAndAssetCtxs' });
    const ctxs = raw?.[1];
    const meta = raw?.[0] as { universe?: Array<{ name?: string }> } | undefined;
    const names = meta?.universe ?? [];
    const idx = names.findIndex((u) => u.name === coin);
    if (idx >= 0 && ctxs?.[idx]) return parseCtx(ctxs[idx]);
  } catch {
    return null;
  }
  return null;
}

export async function fetchClearinghouse(user: string): Promise<Clearinghouse> {
  const [main, hip3, spot, modeRaw] = await Promise.all([
    hlInfo<ClearinghouseRaw>({ type: 'clearinghouseState', user }),
    Promise.all(
      HIP3_DEXES.map((dex) =>
        hlInfo<ClearinghouseRaw>({ type: 'clearinghouseState', user, dex }).catch(() => null),
      ),
    ),
    hlInfo<SpotClearinghouseRaw>({ type: 'spotClearinghouseState', user }).catch(() => null),
    hlInfo<unknown>({ type: 'userAbstraction', user }).catch(() => null),
  ]);

  const positions = [
    ...parsePositions(main, ''),
    ...HIP3_DEXES.flatMap((dex, i) => parsePositions(hip3[i], dex)),
  ];
  const states = [main, ...hip3.filter((s): s is ClearinghouseRaw => !!s)];
  const totalMarginUsed = states.reduce((sum, s) => sum + (num(s.marginSummary?.totalMarginUsed) ?? 0), 0);
  const crossMaintenanceMarginUsed = states.reduce(
    (sum, s) => sum + (num(s.crossMaintenanceMarginUsed) ?? 0),
    0,
  );
  const isolated = states.reduce((sum, s) => sum + isolatedMarginUsed(s), 0);
  const perpAccount = states.reduce((sum, s) => sum + (num(s.marginSummary?.accountValue) ?? 0), 0);
  const perpWithdrawable = states.reduce((sum, s) => sum + (num(s.withdrawable) ?? 0), 0);
  const spotUsdc = spotUsdcFromState(spot);
  const abstractionMode =
    typeof modeRaw === 'string'
      ? modeRaw
      : modeRaw && typeof modeRaw === 'object' && 'abstraction' in modeRaw
        ? String((modeRaw as { abstraction?: unknown }).abstraction ?? '')
        : null;

  const spotBalances = parseSpotBalances(spot);

  // HL: under unified / portfolio margin, perp clearinghouse accountValue is
  // not meaningful — spot USDC is the trading-account balance.
  // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
  const useSpotPool =
    isPooledAccountMode(abstractionMode) ||
    (spotUsdc > 0.01 && perpAccount <= 0.01);
  if (useSpotPool) {
    return {
      accountValue: spotUsdc,
      withdrawable: Math.max(0, spotUsdc - isolated - totalMarginUsed),
      totalMarginUsed,
      crossMaintenanceMarginUsed,
      spotUsdc,
      perpAccountValue: perpAccount,
      perpWithdrawable,
      spotBalances,
      abstractionMode,
      positions,
    };
  }

  return {
    accountValue: perpAccount,
    withdrawable: perpWithdrawable,
    totalMarginUsed,
    crossMaintenanceMarginUsed,
    spotUsdc,
    perpAccountValue: perpAccount,
    perpWithdrawable,
    spotBalances,
    abstractionMode,
    positions,
  };
}

export async function fetchOpenOrders(user: string): Promise<OpenOrder[]> {
  // Mirror mobile `getOpenOrders`: frontendOpenOrders on main + each HIP-3 dex.
  // Plain `openOrders` without `dex` only returns the first perp dex — HIP-3
  // limits (oil, equities, …) never show up even though margin is reserved.
  const fetchDex = async (dex?: string) => {
    const payload: Record<string, unknown> = { type: 'frontendOpenOrders', user };
    if (dex) payload.dex = dex;
    try {
      const raw = await hlInfo<unknown>(payload);
      return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  };

  const [main, ...hip3] = await Promise.all([
    fetchDex(),
    ...HIP3_DEXES.map((dex) => fetchDex(dex)),
  ]);

  const parseOne = (o: Record<string, unknown>, dex: string): OpenOrder | null => {
    const inner =
      o.order && typeof o.order === 'object'
        ? (o.order as Record<string, unknown>)
        : o.o && typeof o.o === 'object'
          ? (o.o as Record<string, unknown>)
          : null;
    const row = inner ? { ...inner, ...o } : o;
    let coin = String(row.coin ?? '');
    if (!coin) return null;
    if (dex && !coin.includes(':')) coin = `${dex}:${coin}`;

    const sz = num(row.sz) ?? 0;
    const orig = num(row.origSz) ?? sz;
    const t = row.orderType ?? row.t;
    let orderType = 'Limit';
    let isTrigger = !!(row.isTrigger ?? row.trigger);
    let tpsl: 'tp' | 'sl' | null = null;
    if (t && typeof t === 'object') {
      const ot = t as { limit?: unknown; trigger?: { tpsl?: string; isMarket?: boolean } };
      if (ot.trigger != null) {
        isTrigger = true;
        const kind = String(ot.trigger.tpsl ?? '').toLowerCase();
        if (kind === 'tp' || kind === 'sl') tpsl = kind;
        const mkt = ot.trigger.isMarket !== false;
        if (kind === 'sl') orderType = mkt ? 'Stop Market' : 'Stop Limit';
        else if (kind === 'tp') orderType = mkt ? 'Take Market' : 'Take Limit';
        else orderType = 'Trigger';
      } else if (ot.limit != null) {
        orderType = 'Limit';
      }
    } else if (typeof t === 'string' && t.trim()) {
      orderType = t;
      if (/stop|take|trigger|tp|sl/i.test(t)) isTrigger = true;
      if (/take|\btp\b/i.test(t)) tpsl = 'tp';
      else if (/stop|\bsl\b/i.test(t)) tpsl = 'sl';
    }
    if (row.tpsl === 'tp' || row.tpsl === 'sl') tpsl = row.tpsl;
    const triggerPx = num(row.triggerPx);
    const cloidRaw = row.cloid ?? row.c;
    const cloid =
      typeof cloidRaw === 'string' && /^0x[0-9a-fA-F]{32}$/.test(cloidRaw) ? cloidRaw.toLowerCase() : null;

    return {
      coin,
      side: (row.side === 'A' ? 'A' : 'B') as 'B' | 'A',
      limitPx: num(row.limitPx) ?? 0,
      sz,
      origSz: orig,
      oid: num(row.oid) ?? 0,
      timestamp: num(row.timestamp ?? row.time) ?? 0,
      orderType,
      reduceOnly: !!(row.reduceOnly ?? row.isReduce),
      isTrigger,
      triggerPx,
      tpsl,
      isPositionTpsl: !!row.isPositionTpsl,
      cloid,
    };
  };

  const out: OpenOrder[] = [];
  const seen = new Set<number>();
  const pushAll = (rows: Array<Record<string, unknown>>, dex: string) => {
    for (const row of rows) {
      const parsed = parseOne(row, dex);
      if (!parsed || !parsed.oid) continue;
      if (seen.has(parsed.oid)) continue;
      seen.add(parsed.oid);
      out.push(parsed);
    }
  };
  pushAll(main, '');
  HIP3_DEXES.forEach((dex, i) => pushAll(hip3[i] ?? [], dex));
  out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return out;
}

export type UserFill = {
  coin: string;
  side: 'B' | 'A';
  px: number;
  sz: number;
  time: number;
  closedPnl: number | null;
  fee: number | null;
  oid: number | null;
  /** Position size before this fill — used to recover open time. */
  startPosition: number | null;
};

export type HistoricalOrder = {
  coin: string;
  side: 'B' | 'A';
  limitPx: number;
  sz: number;
  oid: number;
  status: string;
  timestamp: number;
};

export async function fetchUserFills(user: string): Promise<UserFill[]> {
  const raw = await hlInfo<Array<Record<string, unknown>>>({ type: 'userFills', user });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => ({
      coin: String(f.coin ?? ''),
      side: (f.side === 'A' ? 'A' : 'B') as 'B' | 'A',
      px: num(f.px) ?? 0,
      sz: num(f.sz) ?? 0,
      time: num(f.time) ?? 0,
      closedPnl: num(f.closedPnl),
      fee: num(f.fee),
      oid: num(f.oid),
      startPosition: num(f.startPosition),
    }))
    .filter((f) => f.coin)
    .slice(0, 200);
}

/**
 * Estimate when the current position was opened from fills.
 * Walks chronologically; records the last fill that left flat into a position.
 * Returns null if fills don't cover the open (older than history window).
 */
export function estimatePositionOpenedAt(
  fills: UserFill[],
  coin: string,
): number | null {
  const want = new Set(
    [coin, coin.toUpperCase(), ...(coin.includes(':') ? [coin.split(':').pop() || ''] : [])]
      .filter(Boolean)
      .flatMap((k) => [k, k.toUpperCase()]),
  );
  const rows = fills
    .filter((f) => {
      const base = f.coin.includes(':') ? f.coin.split(':').pop() || f.coin : f.coin;
      return want.has(f.coin) || want.has(f.coin.toUpperCase()) || want.has(base) || want.has(base.toUpperCase());
    })
    .slice()
    .sort((a, b) => (a.time || 0) - (b.time || 0));

  const eps = 1e-8;
  let openedAt: number | null = null;
  for (const f of rows) {
    const start = f.startPosition;
    if (start == null || !f.time) continue;
    const delta = f.side === 'B' ? f.sz : -f.sz;
    const end = start + delta;
    if (Math.abs(start) < eps && Math.abs(end) >= eps) {
      openedAt = f.time;
    } else if (Math.abs(end) < eps) {
      openedAt = null;
    } else if (Math.sign(start) !== 0 && Math.sign(end) !== 0 && Math.sign(start) !== Math.sign(end)) {
      // Flipped through flat in one fill — treat as a new open.
      openedAt = f.time;
    }
  }
  return openedAt;
}

export async function fetchHistoricalOrders(user: string): Promise<HistoricalOrder[]> {
  const raw = await hlInfo<Array<Record<string, unknown>>>({ type: 'historicalOrders', user });
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const o = (row.order ?? row) as Record<string, unknown>;
      const status = String(row.status ?? o.status ?? '');
      return {
        coin: String(o.coin ?? ''),
        side: (o.side === 'A' ? 'A' : 'B') as 'B' | 'A',
        limitPx: num(o.limitPx) ?? 0,
        sz: num(o.sz) ?? 0,
        oid: num(o.oid) ?? 0,
        status,
        timestamp: num(row.statusTimestamp ?? o.timestamp ?? row.time) ?? 0,
      };
    })
    .filter((o) => o.coin)
    .slice(0, 100);
}

/** Fixed-decimal mark formatting so rolling animation does not change string width. */
export function formatMarkStable(v: number, ref: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(Number.isFinite(ref) && ref !== 0 ? ref : v);
  const digits = abs >= 1000 ? 2 : abs >= 100 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : 5;
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: true,
  });
}

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 7 * 86_400_000,
  '1M': 31 * 86_400_000,
};

/** Same per-interval floors as mobile `AssetChart` `effectiveHistoryLimit`. */
const INTERVAL_HISTORY_BARS: Record<CandleInterval, number> = {
  '1m': 480,
  '3m': 400,
  '5m': 320,
  '15m': 320,
  '30m': 240,
  '1h': 240,
  '2h': 240,
  '4h': 240,
  '8h': 240,
  '12h': 240,
  '1d': 240,
  '3d': 240,
  '1w': 240,
  '1M': 240,
};

const MIN_FOR_EMA200 = 220;
/** Mobile adds `period + 60` so long MA/EMA can compute before the viewport. */
const INDICATOR_WARMUP_PAD = 60;
/**
 * Mobile default view is ~45 bars on a phone. The web pane is much wider, so the
 * same 240-bar 4h window shows MA99/EMA200 starting on-screen. Extra bars keep
 * that warmup off the left edge at ~8px candle width.
 */
const DESKTOP_VIEW_PAD = 200;
const MAX_HISTORY_BARS = 2500;
/** HL `candleSnapshot` cap — 1w/1M are built from 1d. */
const HL_DAILY_SNAPSHOT_MAX = 5000;

/** How many chart bars to fetch (mobile limit + desktop viewport pad). */
export function chartHistoryLimit(interval: CandleInterval, maxPeriod = 1): number {
  const base = Math.max(MIN_FOR_EMA200, INTERVAL_HISTORY_BARS[interval] ?? 240);
  const period = Number.isFinite(maxPeriod) ? Math.max(1, Math.round(maxPeriod)) : 1;
  const indicatorBars = period + INDICATOR_WARMUP_PAD + DESKTOP_VIEW_PAD;
  return Math.min(MAX_HISTORY_BARS, Math.max(base, indicatorBars));
}

function dailyLookbackMs(dailyBars: number): number {
  return Math.min(HL_DAILY_SNAPSHOT_MAX, Math.max(1, Math.ceil(dailyBars))) * 86_400_000;
}

export function lookbackMs(interval: CandleInterval): number {
  switch (interval) {
    case '1m':
      return 8 * 3600_000;
    case '3m':
      return 16 * 3600_000;
    case '5m':
      return 2 * 24 * 3600_000;
    case '15m':
      return 5 * 24 * 3600_000;
    case '30m':
      return 8 * 24 * 3600_000;
    case '1h':
      return 14 * 24 * 3600_000;
    case '2h':
      return 21 * 24 * 3600_000;
    case '4h':
      return 40 * 24 * 3600_000;
    case '8h':
      return 60 * 24 * 3600_000;
    case '12h':
      return 90 * 24 * 3600_000;
    case '1d':
      return 180 * 24 * 3600_000;
    case '3d':
      return 365 * 24 * 3600_000;
    case '1w':
      // Built from 1d into Monday-UTC weeks; keep enough dailies for ~2y of W bars.
      return 2 * 365 * 24 * 3600_000;
    case '1M':
      // Built from 1d into UTC calendar months; ~5y of daily history.
      return 5 * 365 * 24 * 3600_000;
    default:
      return 5 * 24 * 3600_000;
  }
}

/** REST window: never shorter than `lookbackMs`, sized for MA/EMA warmup like mobile. */
export function chartLookbackMs(interval: CandleInterval, maxPeriod = 1): number {
  const bars = chartHistoryLimit(interval, maxPeriod);
  const fromBars =
    interval === '1w'
      ? dailyLookbackMs(bars * 7 + 7)
      : interval === '1M'
        ? dailyLookbackMs(bars * 31 + 31)
        : bars * CANDLE_INTERVAL_MS[interval];
  return Math.max(lookbackMs(interval), fromBars);
}
