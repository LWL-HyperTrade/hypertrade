/**
 * PONS v2 ONLY.
 * Canonical docs: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1.
 *
 * Identity (CA, symbol, launched_at) is ours (`tenants.coin_*`).
 * Price / mcap / 24h: Dexscreener when a Robinhood v4 pool exists (graduated).
 * Still on the v2 curve: on-chain `getReserves` + totalSupply (24h is —).
 * We do not scrape ponsfamily.com.
 */
import { formatUnits, parseAbiItem, type Address, type Hex } from 'viem';
import { CURVE_ABI, ERC20_ABI } from './abi';
import { getRobinhoodPublicClient, isNativeQuote, robinhoodTokenUrl } from './chain';
import type { TenantCoin } from '../tenants';

/**
 * Pre-graduation stats derived from CurveBuy / CurveSell logs. Nothing off-chain
 * indexes a curve token (Gecko / Dexscreener only see the v4 pool), so this is
 * the only source for trades, 24h volume, holders and the price sparkline
 * while a launch is still on the curve.
 */
export type CurveActivity = {
  /** Lifetime CurveBuy + CurveSell count. */
  trades: number;
  /** Quote spent + received in the last ~24h, in quote units (ETH or pair token). */
  volumeQuote24h: number;
  volumeUsd24h: number | null;
  /** Addresses with a positive net position from curve trades (transfers ignored). */
  holders: number;
  /** Trade-by-trade quote-per-token price, oldest → newest. */
  spark: number[];
};

/** docs.ponsfamily.com/v2 → Indexing launches and trades */
const CURVE_TRADE_EVENTS = [
  parseAbiItem(
    'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  ),
  parseAbiItem(
    'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  ),
] as const;

/** Robinhood WETH — used only to price native-ETH curve quotes into USD. */
const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
/** Robinhood Global Dollar — treat as $1 when Dexscreener has no pair yet. */
const ROBINHOOD_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const DEX_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const STABLE_SYMBOLS = new Set(['USDG', 'USDC', 'USDT', 'DAI', 'USD']);

export type CoinGraduation = {
  pct: number;
  graduated: boolean;
};

export type CoinMarket = {
  token: string;
  priceUsd: number | null;
  mcapUsd: number | null;
  /** USD per unit of the quote asset (ETH or pair token). Curve source only. */
  quoteUsd: number | null;
  volumeUsd: number | null;
  /** Curve: lifetime CurveBuy+CurveSell. Dex: 24h buys+sells from Dexscreener. */
  trades: number | null;
  holders: number | null;
  change24h: number | null;
  graduation: CoinGraduation | null;
  source: 'dex' | 'curve';
  dexUrl: string;
  geckoUrl: string;
  ponsUrl: string;
  explorerUrl: string;
};

export function dexscreenerTokenUrl(token: string): string {
  return `https://dexscreener.com/robinhood/${token}`;
}

export function geckoTokenUrl(token: string): string {
  return `https://www.geckoterminal.com/robinhood/tokens/${token}`;
}

export function ponsLaunchpadUrl(token: string): string {
  return `https://www.ponsfamily.com/launchpad/${token}`;
}

export function tokenLinks(token: string) {
  return {
    dexUrl: dexscreenerTokenUrl(token),
    geckoUrl: geckoTokenUrl(token),
    ponsUrl: ponsLaunchpadUrl(token),
    explorerUrl: robinhoodTokenUrl(token),
  };
}

type DexPair = {
  chainId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  liquidity?: { usd?: number };
};

type DexResponse = { pairs?: DexPair[] | null };

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchDexPairs(addresses: string[]): Promise<DexPair[]> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => a && a !== '0x0000000000000000000000000000000000000000'))];
  if (!uniq.length) return [];
  const batches = await Promise.all(
    chunk(uniq, 20).map(async (addrs) => {
      try {
        const res = await fetch(`${DEX_TOKENS}/${addrs.join(',')}`);
        if (!res.ok) return [] as DexPair[];
        const data = (await res.json()) as DexResponse;
        return data.pairs ?? [];
      } catch {
        return [] as DexPair[];
      }
    }),
  );
  return batches.flat();
}

function pickPair(pairs: DexPair[], token: string): DexPair | null {
  const want = token.toLowerCase();
  const matches = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === want);
  const robinhood = matches.filter((p) => (p.chainId || '').toLowerCase() === 'robinhood');
  const pool = robinhood.length ? robinhood : matches;
  if (!pool.length) return null;
  return [...pool].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

function dexTrades(pair: DexPair): number | null {
  const buys = num(pair.txns?.h24?.buys) ?? 0;
  const sells = num(pair.txns?.h24?.sells) ?? 0;
  const total = buys + sells;
  if (!pair.txns?.h24) return null;
  return total;
}

function fromDex(token: string, pair: DexPair): CoinMarket {
  const links = tokenLinks(token);
  return {
    token: token.toLowerCase(),
    priceUsd: num(pair.priceUsd),
    mcapUsd: num(pair.marketCap) ?? num(pair.fdv),
    quoteUsd: null,
    volumeUsd: num(pair.volume?.h24),
    trades: dexTrades(pair),
    holders: null,
    change24h: num(pair.priceChange?.h24),
    graduation: null,
    source: 'dex',
    dexUrl: pair.url || links.dexUrl,
    geckoUrl: links.geckoUrl,
    ponsUrl: links.ponsUrl,
    explorerUrl: links.explorerUrl,
  };
}

/**
 * Block the launch tx landed in. `eth_getLogs` with no `fromBlock` is
 * `latest..latest` on most nodes, which is why an unbounded query always
 * returned zero trades. Bounding at the launch block keeps the range small
 * enough for Alchemy / public RPC limits. Cached per tx for the session.
 */
const launchBlockCache = new Map<string, Promise<bigint | null>>();
function launchBlockOf(coin: TenantCoin): Promise<bigint | null> {
  const key = (coin.tx_hash || '').toLowerCase();
  if (!key) return Promise.resolve(null);
  let p = launchBlockCache.get(key);
  if (!p) {
    p = getRobinhoodPublicClient()
      .getTransactionReceipt({ hash: key as Hex })
      .then((r) => r.blockNumber)
      .catch(() => null);
    launchBlockCache.set(key, p);
  }
  return p;
}

type CurveLog = Awaited<ReturnType<ReturnType<typeof getRobinhoodPublicClient>['getLogs']>>[number] & {
  eventName?: string;
  args?: Record<string, bigint | string | undefined>;
};

const LOGS_TTL_MS = 12_000;
const curveLogsCache = new Map<string, { at: number; p: Promise<CurveLog[]> }>();

/** All CurveBuy / CurveSell logs for one curve, launch block → latest. */
function curveLogs(coin: TenantCoin): Promise<CurveLog[]> {
  const curve = (coin.curve || '').toLowerCase();
  if (!curve) return Promise.resolve([]);
  const hit = curveLogsCache.get(curve);
  if (hit && Date.now() - hit.at < LOGS_TTL_MS) return hit.p;
  const p = (async () => {
    const fromBlock = (await launchBlockOf(coin)) ?? 'earliest';
    const logs = await getRobinhoodPublicClient().getLogs({
      address: curve as Address,
      events: CURVE_TRADE_EVENTS,
      fromBlock,
      toBlock: 'latest',
    });
    return logs as CurveLog[];
  })().catch(() => {
    curveLogsCache.delete(curve);
    return [] as CurveLog[];
  });
  curveLogsCache.set(curve, { at: Date.now(), p });
  return p;
}

/** Lifetime CurveBuy + CurveSell count for one launch (docs → Indexing trades). */
export async function fetchCurveTradeCount(coin: TenantCoin | null | undefined): Promise<number | null> {
  if (!coin?.curve) return null;
  try {
    return (await curveLogs(coin)).length;
  } catch {
    return null;
  }
}

const SPARK_MAX = 80;

function sparkFromLogs(logs: CurveLog[]): number[] {
  const pts: number[] = [];
  for (const log of logs) {
    const a = (log.args ?? {}) as Record<string, bigint | undefined>;
    let px: number | null = null;
    if (a.quoteIn != null && a.tokensOut != null && a.tokensOut > 0n) {
      px = Number(a.quoteIn) / Number(a.tokensOut);
    } else if (a.quoteOut != null && a.tokensIn != null && a.tokensIn > 0n) {
      px = Number(a.quoteOut) / Number(a.tokensIn);
    }
    if (px != null && Number.isFinite(px) && px > 0) pts.push(px);
  }
  return pts.slice(-SPARK_MAX);
}

/** Trade-by-trade price on the curve (quote per token). Shape only — raw units. */
async function curveSparkline(coin: TenantCoin): Promise<number[]> {
  try {
    return sparkFromLogs(await curveLogs(coin));
  } catch {
    return [];
  }
}

const DAY_SEC = 86_400n;

/**
 * Block number ~24h ago, estimated from the launch block and latest block
 * timestamps (block time on Robinhood Chain is not fixed). `null` when the
 * launch itself is under 24h old — every log counts.
 */
async function blockCutoff24h(coin: TenantCoin): Promise<bigint | null> {
  const client = getRobinhoodPublicClient();
  const launchBlock = await launchBlockOf(coin);
  if (launchBlock == null) return null;
  const [latest, launch] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.getBlock({ blockNumber: launchBlock }),
  ]);
  const elapsed = latest.timestamp - launch.timestamp;
  if (elapsed <= DAY_SEC) return null;
  const blocks = latest.number - launch.number;
  if (blocks <= 0n) return null;
  const perDay = (blocks * DAY_SEC) / elapsed;
  return latest.number - perDay;
}

/**
 * Trades / 24h volume / holders / sparkline for a launch still on its curve.
 * One `eth_getLogs` (cached ~12s) plus two block reads.
 */
export async function fetchCurveActivity(
  coin: TenantCoin | null | undefined,
  quoteUsd: number | null | undefined,
  quoteDecimals = 18,
): Promise<CurveActivity | null> {
  if (!coin?.curve) return null;
  try {
    const [logs, cutoff] = await Promise.all([curveLogs(coin), blockCutoff24h(coin).catch(() => null)]);
    let vol = 0n;
    const net = new Map<string, bigint>();
    for (const log of logs) {
      const a = (log.args ?? {}) as Record<string, bigint | string | undefined>;
      const inWindow = cutoff == null || (log.blockNumber != null && log.blockNumber >= cutoff);
      if (log.eventName === 'CurveBuy') {
        const q = (a.quoteIn as bigint | undefined) ?? 0n;
        const t = (a.tokensOut as bigint | undefined) ?? 0n;
        const who = String(a.recipient ?? '').toLowerCase();
        if (inWindow) vol += q;
        if (who) net.set(who, (net.get(who) ?? 0n) + t);
      } else if (log.eventName === 'CurveSell') {
        const q = (a.quoteOut as bigint | undefined) ?? 0n;
        const t = (a.tokensIn as bigint | undefined) ?? 0n;
        const who = String(a.seller ?? '').toLowerCase();
        if (inWindow) vol += q;
        if (who) net.set(who, (net.get(who) ?? 0n) - t);
      }
    }
    let holders = 0;
    for (const v of net.values()) if (v > 0n) holders += 1;
    const volumeQuote24h = Number(formatUnits(vol, quoteDecimals));
    const usd = quoteUsd != null && Number.isFinite(quoteUsd) ? quoteUsd : null;
    return {
      trades: logs.length,
      volumeQuote24h,
      volumeUsd24h: usd != null ? volumeQuote24h * usd : null,
      holders,
      spark: sparkFromLogs(logs),
    };
  } catch {
    return null;
  }
}

/**
 * Dexscreener "Enhanced Token Info" (the paid profile launchpads badge as
 * "DEX paid"). Free, key-less: `GET /orders/v1/{chain}/{token}` lists the
 * token's orders; an approved `tokenProfile` is the paid badge. 60 req/min.
 */
export type DexscreenerPaid = {
  paid: boolean;
  /** Approved order types, e.g. ['tokenProfile', 'tokenAd']. */
  approved: string[];
  /** Any order still `processing` / `on-hold`. */
  pending: boolean;
  url: string;
};

type DexOrder = { type?: string; status?: string; paymentTimestamp?: number };

export async function fetchDexscreenerPaid(token: string | null | undefined): Promise<DexscreenerPaid | null> {
  if (!token) return null;
  const url = dexscreenerTokenUrl(token);
  try {
    const res = await fetch(`https://api.dexscreener.com/orders/v1/robinhood/${token.toLowerCase()}`);
    if (res.status === 404) return { paid: false, approved: [], pending: false, url };
    if (!res.ok) return null;
    const data = (await res.json()) as DexOrder[] | { orders?: DexOrder[] } | null;
    const orders = Array.isArray(data) ? data : (data?.orders ?? []);
    const approved = orders.filter((o) => o.status === 'approved').map((o) => String(o.type ?? ''));
    const pending = orders.some((o) => o.status === 'processing' || o.status === 'on-hold');
    return { paid: approved.includes('tokenProfile'), approved, pending, url };
  } catch {
    return null;
  }
}

/**
 * "% to graduation" — small raises must not round to 0. Under 0.1% shows
 * `<0.1%`; under 10% one decimal; otherwise whole percent.
 */
export function formatGraduationPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  if (pct <= 0) return '0%';
  if (pct >= 100) return '100%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Progress-bar width: anything above zero shows at least a sliver. */
export function graduationBarWidth(pct: number | null | undefined): number {
  if (pct == null || !Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(100, Math.max(1, pct));
}

/** Hourly closes from GeckoTerminal once a Robinhood pool exists. Oldest → newest. */
async function dexSparkline(token: string): Promise<number[]> {
  try {
    const poolsRes = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token.toLowerCase()}/pools`,
    );
    if (!poolsRes.ok) return [];
    const pools = (await poolsRes.json()) as { data?: { attributes?: { address?: string } }[] };
    const pool = pools.data?.[0]?.attributes?.address;
    if (!pool) return [];
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/hour?aggregate=1&limit=${SPARK_MAX}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: number[][] } };
    };
    const list = data.data?.attributes?.ohlcv_list ?? [];
    return list
      .map((row) => num(row[4]))
      .filter((v): v is number => v != null && v > 0)
      .reverse();
  } catch {
    return [];
  }
}

/** Price history for the creator page sparkline. Empty when nothing has traded. */
export async function fetchTokenSparkline(
  coin: TenantCoin,
  source: CoinMarket['source'] | undefined,
): Promise<number[]> {
  if (!coin?.token) return [];
  if (source === 'dex') {
    const dex = await dexSparkline(coin.token);
    if (dex.length >= 2) return dex;
  }
  if (coin.curve) return curveSparkline(coin);
  return [];
}

function ethUsdFromPairs(pairs: DexPair[]): number | null {
  const weth = ROBINHOOD_WETH.toLowerCase();
  const hits = pairs.filter((p) => {
    const base = p.baseToken?.address?.toLowerCase();
    const quote = (p.quoteToken?.symbol || '').toUpperCase();
    return base === weth && STABLE_SYMBOLS.has(quote);
  });
  const best = [...hits].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (best) return num(best.priceUsd);
  const any = pickPair(pairs, ROBINHOOD_WETH);
  return any ? num(any.priceUsd) : null;
}

function quoteUsdFromPairs(pairs: DexPair[], pairToken: string): number | null {
  if (isNativeQuote(pairToken)) return null;
  if (pairToken.toLowerCase() === ROBINHOOD_USDG.toLowerCase()) return 1;
  const pair = pickPair(pairs, pairToken);
  return pair ? num(pair.priceUsd) : null;
}

async function quoteUsdForCoin(
  coin: TenantCoin,
  pairs: DexPair[],
  ethUsd: number | null,
): Promise<number | null> {
  if (isNativeQuote(coin.pair_token)) return ethUsd;
  const fromDex = quoteUsdFromPairs(pairs, coin.pair_token);
  if (fromDex != null) return fromDex;
  try {
    const sym = (
      await getRobinhoodPublicClient().readContract({
        address: coin.pair_token as Address,
        abi: ERC20_ABI,
        functionName: 'symbol',
      })
    ).toUpperCase();
    if (STABLE_SYMBOLS.has(sym)) return 1;
  } catch {
    /* quote stays unknown — card still shows CA / age */
  }
  return null;
}

async function curveMarket(
  coin: TenantCoin,
  quoteUsd: number | null,
): Promise<CoinMarket | null> {
  if (!coin.curve || !coin.token) return null;
  const client = getRobinhoodPublicClient();
  const token = coin.token as Address;
  const curve = coin.curve as Address;
  try {
    const [reserves, supply, tokenDec, realQuote, threshold, done] = await Promise.all([
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'getReserves' }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'realQuoteReserve' }),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduationThreshold' }),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated' }),
    ]);
    const [quoteReserve, tokenReserve] = reserves;
    if (tokenReserve === 0n || supply === 0n) return null;

    let quoteDecimals = 18;
    if (!isNativeQuote(coin.pair_token)) {
      quoteDecimals = Number(
        await client.readContract({
          address: coin.pair_token as Address,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      );
    }

    const q = Number(formatUnits(quoteReserve, quoteDecimals));
    const t = Number(formatUnits(tokenReserve, Number(tokenDec)));
    const supplyN = Number(formatUnits(supply, Number(tokenDec)));
    if (!Number.isFinite(q) || !Number.isFinite(t) || t <= 0 || !Number.isFinite(supplyN)) return null;
    const priceQuote = q / t;
    const mcapQuote = priceQuote * supplyN;
    const usd = quoteUsd != null && Number.isFinite(quoteUsd) ? quoteUsd : null;
    const links = tokenLinks(coin.token);
    return {
      token: coin.token.toLowerCase(),
      priceUsd: usd != null ? priceQuote * usd : null,
      mcapUsd: usd != null ? mcapQuote * usd : null,
      quoteUsd: usd,
      volumeUsd: null,
      trades: null,
      holders: null,
      change24h: null,
      graduation: graduationFrom(realQuote, threshold, done),
      source: 'curve',
      ...links,
    };
  } catch {
    return null;
  }
}

function graduationFrom(real: bigint, threshold: bigint, done: boolean): CoinGraduation {
  if (done) return { pct: 100, graduated: true };
  if (threshold === 0n) return { pct: 0, graduated: false };
  const pct = Math.min(100, Number((real * 10_000n) / threshold) / 100);
  return { pct: Number.isFinite(pct) ? pct : 0, graduated: false };
}

async function readGraduation(coin: TenantCoin): Promise<CoinGraduation | null> {
  if (!coin.curve) return null;
  const client = getRobinhoodPublicClient();
  const curve = coin.curve as Address;
  try {
    const [real, threshold, done] = await Promise.all([
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'realQuoteReserve' }),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduationThreshold' }),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated' }),
    ]);
    return graduationFrom(real, threshold, done);
  } catch {
    return null;
  }
}

async function fetchHolders(addresses: string[]): Promise<Record<string, number>> {
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
  const out: Record<string, number> = {};
  await Promise.all(
    uniq.map(async (addr) => {
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${addr}/info`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          data?: { attributes?: { holders?: { count?: number } } };
        };
        const n = Number(data.data?.attributes?.holders?.count);
        if (Number.isFinite(n)) out[addr] = n;
      } catch {
        /* Gecko has not indexed the token yet */
      }
    }),
  );
  return out;
}

/** GeckoTerminal pool snapshot — fallback for non-Pons tokens Dexscreener has not indexed. */
async function geckoPoolMarket(coin: TenantCoin): Promise<CoinMarket | null> {
  if (!coin.pool || !coin.token) return null;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${coin.pool.toLowerCase()}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: {
        attributes?: {
          base_token_price_usd?: string;
          market_cap_usd?: string | null;
          fdv_usd?: string | null;
          volume_usd?: { h24?: string };
          price_change_percentage?: { h24?: string };
          transactions?: { h24?: { buys?: number; sells?: number } };
        };
      };
    };
    const a = data.data?.attributes;
    if (!a) return null;
    const price = num(a.base_token_price_usd);
    if (price == null) return null;
    const tx = a.transactions?.h24;
    const links = tokenLinks(coin.token);
    return {
      token: coin.token.toLowerCase(),
      priceUsd: price,
      mcapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
      quoteUsd: null,
      volumeUsd: num(a.volume_usd?.h24),
      trades: tx ? (num(tx.buys) ?? 0) + (num(tx.sells) ?? 0) : null,
      holders: null,
      change24h: num(a.price_change_percentage?.h24),
      graduation: null,
      source: 'dex',
      ...links,
      geckoUrl: `https://www.geckoterminal.com/robinhood/pools/${coin.pool}`,
    };
  } catch {
    return null;
  }
}

const isExternal = (c: TenantCoin) => c.source === 'external';

export async function fetchCoinMarkets(coins: TenantCoin[]): Promise<Record<string, CoinMarket>> {
  const live = coins.filter((c) => c?.token);
  if (!live.length) return {};

  const tokenAddrs = live.map((c) => c.token);
  const pairAddrs = live.map((c) => c.pair_token).filter((a) => a && !isNativeQuote(a));
  const pairs = await fetchDexPairs([...tokenAddrs, ...pairAddrs, ROBINHOOD_WETH]);
  const ethUsd = ethUsdFromPairs(pairs);

  const out: Record<string, CoinMarket> = {};
  const missing: TenantCoin[] = [];

  for (const coin of live) {
    const pair = pickPair(pairs, coin.token);
    if (pair && num(pair.priceUsd) != null) {
      out[coin.token.toLowerCase()] = fromDex(coin.token, pair);
    } else {
      missing.push(coin);
    }
  }

  await Promise.all(
    missing.map(async (coin) => {
      if (isExternal(coin)) {
        const m = await geckoPoolMarket(coin);
        if (m) out[coin.token.toLowerCase()] = m;
        return;
      }
      const quoteUsd = await quoteUsdForCoin(coin, pairs, ethUsd);
      const m = await curveMarket(coin, quoteUsd);
      if (m) out[coin.token.toLowerCase()] = m;
    }),
  );

  await Promise.all(
    live.map(async (coin) => {
      const m = out[coin.token.toLowerCase()];
      if (!m || m.graduation || isExternal(coin)) return;
      m.graduation = await readGraduation(coin);
    }),
  );

  const holders = await fetchHolders(Object.keys(out));
  const byToken = new Map(live.map((c) => [c.token.toLowerCase(), c]));
  for (const [token, m] of Object.entries(out)) {
    const showcase = byToken.get(token)?.holders;
    m.holders =
      showcase != null && Number.isFinite(showcase) ? showcase : (holders[token] ?? null);
  }

  return out;
}
