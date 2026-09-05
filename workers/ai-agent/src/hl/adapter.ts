/**
 * HL execution adapter for AI agents — server-side, narrow port of the order
 * paths in frontend/src/lib/hyperliquid.ts (which is RN-coupled and not
 * importable here). Built on @nktkas/hyperliquid, same lib as the app.
 *
 * SECURITY MODEL — every AI decision passes through the hard caps here; the
 * LLM output is untrusted input and prompts are NOT a security boundary:
 *   • symbol must be in the agent's configured allowlist (main dex +
 *     catalogued HIP-3 coins on SUPPORTED_HIP3_DEXES — e.g. `xyz:TSLA`)
 *   • leverage clamped to config.leverage_cap
 *   • open/add notional capped so total agent exposure ≤ max_capital_usd
 *     (notional ceiling for both shared and dedicated; sub free margin also clamps)
 *   • close/trim are always reduce-only
 *   • dry_run agents never reach the exchange client
 *
 * Copilot (shared account) agents get the symbol-conflict guard; Dedicated
 * agents pass `vaultAddress` (their subaccount) on every exchange call.
 */
import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
} from '@nktkas/hyperliquid';
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';
import { config, isTestnet } from '../config.js';
import type { AgentConfig } from '../types.js';
import { HlCycleCache } from './cycleCache.js';
import { HL_WEIGHT, HlWeightBucket } from './rateLimit.js';
import {
  isIocNoMatch,
  resolveBookSlippage,
  resolveCloseSlippage,
  resolveOpenSlippage,
  widenSlippage,
} from './slippage.js';
import { parseL2Book, type BookSnapshot, type TakeSide } from './bookSnapshot.js';
import { liquidityTier } from './liquidityTier.js';
import { resolveLiveOwnership, type HlFillLite } from './positionIdentity.js';

type Hex = `0x${string}`;

/** Book age tolerated for PROMPT context (minutes are fine for an hourly brain). */
export const BOOK_PROMPT_MAX_AGE_MS = 5 * 60_000;
/** Book age tolerated when computing an order price / gate (seconds). */
export const BOOK_EXEC_MAX_AGE_MS = 10_000;
/** HL minimum order notional — a maker remainder below this is left unfilled. */
const HL_MIN_ORDER_NOTIONAL_USD = 10;
/** Poll cadence while a maker (ALO) open rests. */
const MAKER_POLL_MS = 2_500;

/** Notional ceiling from config (same for shared + dedicated). */
function notionalBudgetUsd(config: AgentConfig, _isDedicated: boolean): number {
  const cap = Number(config.max_capital_usd);
  return cap > 0 ? cap : 0;
}

/**
 * Process-wide active cycle cache. Set by the worker at the start of each
 * cycle so free helpers (getMidPrice) and every adapter share one map.
 * Cleared when the cycle ends.
 */
let activeCycleCache: HlCycleCache | null = null;

export function beginHlCycleCache(): HlCycleCache {
  activeCycleCache = new HlCycleCache();
  return activeCycleCache;
}

export function endHlCycleCache(): void {
  activeCycleCache = null;
}

function cycleCache(): HlCycleCache | null {
  return activeCycleCache;
}

/** Burst ≈ 5s of refill, min 30 weight so a wallet bundle (2+2+20) fits. */
const hlBucket = new HlWeightBucket(
  config.hlWeightPerMinute,
  Math.max(30, Math.ceil(config.hlWeightPerMinute / 12)),
);

export interface AdapterPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sizeUnits: number;
  notionalUsd: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPx: number | null;
  /**
   * HL leverage.type — the risk model differs fundamentally: cross positions
   * share the pool buffer (liq distance ∝ equity/notional); isolated
   * positions' own margin is the ENTIRE buffer (liq distance ≈ 1/leverage).
   */
  marginType: 'cross' | 'isolated' | null;
  /**
   * HL `cumFunding.sinceOpen` (raw): positive = funding paid by the position
   * (cost to user). Portfolio UI flips the sign for display; monitors should
   * use `fundingPnlForUserUsd = -cumFundingSinceOpen`.
   */
  cumFundingSinceOpen: number | null;
}

export interface OpenParams {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sizeUsd: number;
  leverage: number;
  /** 128-bit hex cloid tagging the order as this agent's (0x + 32 hex chars). */
  cloid?: Hex;
  slippage?: number;
  /**
   * `maker_first` (default when config.makerFirstOpen): ALO at the touch,
   * bounded wait, IOC remainder. `ioc`: legacy taker-only path.
   */
  execution?: 'maker_first' | 'ioc';
}

/**
 * Same agent identity (0x + 'HTAI' + 8-hex agent hash = 18 chars), fresh
 * random tail. Used for the IOC leg after a maker leg so both fills carry
 * the agent prefix (positionIdentity matches on prefix only) without ever
 * reusing a cloid HL may still associate with the resting/cancelled order.
 */
export function deriveSiblingCloid(cloid: Hex): Hex {
  const prefix = cloid.slice(0, 18);
  let tail = '';
  for (let i = 0; i < 16; i += 1) tail += Math.floor(Math.random() * 16).toString(16);
  return `${prefix}${tail}` as Hex;
}

export interface AdapterResult {
  ok: boolean;
  detail: string;
}

/** One transport per worker process; both HL envs use the SDK's own URLs. */
const transport = new HttpTransport({ isTestnet: isTestnet() });
const info = new InfoClient({ transport });

/** Best-effort HL rate-limit detection (info + exchange). */
function isHlRateLimitError(err: unknown): boolean {
  if (err == null) return false;
  const any = err as { status?: number; code?: number; message?: string };
  if (any.status === 429 || any.code === 429) return true;
  const msg = String(err instanceof Error ? err.message : err);
  return /(^|[^\d])429([^\d]|$)/.test(msg) || /rate.?limit|too many requests/i.test(msg);
}

function isRetryableCloseDetail(detail: string): boolean {
  return (
    isHlRateLimitError(detail) ||
    isIocNoMatch(detail) ||
    /timeout|temporar|unavailable|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(detail)
  );
}

/**
 * Acquire HL weight, then call. On 429: wait + retry (linear backoff).
 * Weight is only consumed once per successful attempt start — retries
 * re-acquire so a stampede after cooldown still respects the bucket.
 */
async function withHlRetry<T>(
  fn: () => Promise<T>,
  weight: number,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await hlBucket.acquire(weight);
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isHlRateLimitError(err) || i === attempts - 1) throw err;
      await sleep(2_000 * (i + 1) + Math.random() * 1_000);
    }
  }
  throw lastErr;
}

/** Exchange writes: bucket + optional 429 retry (close path has its own loop). */
async function withHlExchange<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await hlBucket.acquire(HL_WEIGHT.exchange);
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isHlRateLimitError(err) || i === attempts - 1) throw err;
      await sleep(3_000 * (i + 1) + Math.random() * 1_000);
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── HIP-3 (builder-dex) support ─────────────────────────────────────────────
// Proven by spikes/prove-agent-send-asset/prove-xyz-order.ts (2026-07): on
// unifiedAccount the agent key trades `xyz:*` directly — spot USDC is the
// margin source, NO agentSendAsset/JIT funding needed. Builder-dex asset ids
// are 100000 + dexIndex*10000 + universeIndex (HL docs).

/** HIP-3 dexes agents may trade. Protocol is `{dex}:{COIN}` for any deployer.
 * Catalog + exclude + isPreIpo still decide which tickers are allowed. */
export const SUPPORTED_HIP3_DEXES = new Set(['xyz', 'io']);

/** `xyz:TSLA` → 'xyz'; main-dex symbols → null. Case-insensitive. */
export function symbolDex(symbol: string): string | null {
  const i = symbol.indexOf(':');
  return i > 0 ? symbol.slice(0, i).toLowerCase() : null;
}

const HL_INFO_URL = isTestnet()
  ? 'https://api.hyperliquid-testnet.xyz/info'
  : 'https://api.hyperliquid.xyz/info';

/**
 * Raw info POST for dex-scoped queries the pinned SDK (0.32.x) doesn't type
 * (`meta`/`metaAndAssetCtxs`/`clearinghouseState` with `dex`, `perpDexs`).
 * Same weight bucket + retry as SDK calls.
 */
async function hlInfoRaw<T>(body: Record<string, unknown>, weight: number): Promise<T> {
  return withHlRetry(async () => {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`HL info ${String(body.type)} HTTP ${res.status}`);
      (err as { status?: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }, weight);
}

let perpDexsCache: { at: number; indexByName: Map<string, number> } | null = null;
const PERP_DEXS_TTL_MS = 6 * 60 * 60 * 1000;

/** Per-dex clearinghouse cache (key `${user}|${dex}`) — see loadDexClearinghouse. */
const dexClearinghouseCache = new Map<string, { at: number; data: any }>();
const DEX_CLEARINGHOUSE_TTL_MS = 45_000;

/** Shared clearinghouseState → AdapterPosition[] parser (main and HIP-3 dexes). */
function parseClearinghousePositions(state: any): AdapterPosition[] {
  const out: AdapterPosition[] = [];
  for (const ap of state?.assetPositions ?? []) {
    const p = ap.position;
    const szi = Number(p?.szi ?? 0);
    if (!p || szi === 0) continue;
    const entryPx = Number(p.entryPx ?? 0);
    const lev =
      typeof p.leverage === 'object' ? Number(p.leverage?.value ?? 1) : Number(p.leverage ?? 1);
    const levType =
      typeof p.leverage === 'object' ? String(p.leverage?.type ?? '') : '';
    const rawCum = p.cumFunding?.sinceOpen;
    const cumFundingSinceOpen =
      rawCum != null && Number.isFinite(Number(rawCum)) ? Number(rawCum) : null;
    out.push({
      symbol: p.coin,
      direction: szi > 0 ? 'LONG' : 'SHORT',
      sizeUnits: Math.abs(szi),
      notionalUsd: Number(p.positionValue ?? Math.abs(szi) * entryPx),
      entryPrice: entryPx,
      unrealizedPnl: Number(p.unrealizedPnl ?? 0),
      leverage: lev,
      liquidationPx: p.liquidationPx != null ? Number(p.liquidationPx) : null,
      marginType: levType === 'isolated' ? 'isolated' : levType === 'cross' ? 'cross' : null,
      cumFundingSinceOpen,
    });
  }
  return out;
}

async function getPerpDexIndex(dex: string): Promise<number> {
  if (!perpDexsCache || Date.now() - perpDexsCache.at > PERP_DEXS_TTL_MS) {
    const dexes = await hlInfoRaw<Array<{ name?: string } | null>>(
      { type: 'perpDexs' },
      HL_WEIGHT.meta,
    );
    const indexByName = new Map<string, number>();
    dexes.forEach((d, i) => {
      if (d?.name) indexByName.set(String(d.name).toLowerCase(), i);
    });
    perpDexsCache = { at: Date.now(), indexByName };
  }
  const idx = perpDexsCache.indexByName.get(dex);
  if (idx == null) throw new Error(`HIP-3 dex not found on HL: ${dex}`);
  return idx;
}

interface AssetMeta {
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  /** HIP-3 assets may reject cross margin — order path must honor this. */
  onlyIsolated: boolean;
}

/** Meta cache per dex ('' = main). */
const metaCaches = new Map<string, { at: number; bySymbol: Map<string, AssetMeta> }>();
const META_TTL_MS = 10 * 60 * 1000;

async function getAssetMeta(symbol: string): Promise<AssetMeta> {
  const dex = symbolDex(symbol) ?? '';
  if (dex && !SUPPORTED_HIP3_DEXES.has(dex)) {
    throw new Error(`HIP-3 dex not supported: ${dex} (symbol ${symbol})`);
  }
  let cached = metaCaches.get(dex);
  if (!cached || Date.now() - cached.at > META_TTL_MS) {
    const bySymbol = new Map<string, AssetMeta>();
    if (!dex) {
      const meta = await withHlRetry(() => info.meta(), HL_WEIGHT.meta);
      meta.universe.forEach((u, i) => {
        bySymbol.set(u.name.toUpperCase(), {
          assetId: i,
          szDecimals: u.szDecimals,
          maxLeverage: u.maxLeverage,
          onlyIsolated: !!(u as { onlyIsolated?: boolean }).onlyIsolated,
        });
      });
    } else {
      const dexIndex = await getPerpDexIndex(dex);
      const meta = await hlInfoRaw<{
        universe?: Array<{
          name?: string;
          szDecimals?: number;
          maxLeverage?: number;
          onlyIsolated?: boolean;
        }>;
      }>({ type: 'meta', dex }, HL_WEIGHT.meta);
      (meta.universe ?? []).forEach((u, i) => {
        const name = String(u.name ?? '');
        if (!name) return;
        const entry: AssetMeta = {
          assetId: 100_000 + dexIndex * 10_000 + i,
          szDecimals: Number(u.szDecimals ?? 0),
          maxLeverage: Math.max(1, Number(u.maxLeverage ?? 1)),
          onlyIsolated: !!u.onlyIsolated,
        };
        // Universe names vary between "TSLA" and "xyz:TSLA" — key both forms.
        bySymbol.set(name.toUpperCase(), entry);
        if (!name.includes(':')) bySymbol.set(`${dex}:${name}`.toUpperCase(), entry);
      });
    }
    cached = { at: Date.now(), bySymbol };
    metaCaches.set(dex, cached);
  }
  const m = cached.bySymbol.get(symbol.toUpperCase());
  if (!m) throw new Error(`Unknown ${dex || 'main-dex'} perp symbol: ${symbol}`);
  return m;
}

/** HL max leverage for a main-dex perp (meta-cached). */
export async function getAssetMaxLeverage(symbol: string): Promise<number> {
  const meta = await getAssetMeta(symbol);
  return Math.max(1, meta.maxLeverage || 1);
}

/**
 * Desired agent leverage clamped to the asset's HL max (and ≥ 1).
 * Use for margin preflight + open/flip so low-max alts don't inherit
 * optimistic headroom from a high basket ceiling.
 */
export async function effectiveOpenLeverage(
  desiredLeverage: number,
  symbol: string,
): Promise<number> {
  const want = Math.max(1, desiredLeverage);
  const assetMax = await getAssetMaxLeverage(symbol).catch(() => want);
  return Math.max(1, Math.min(want, assetMax));
}

/** Whether an asset rejects cross margin (HIP-3 `onlyIsolated` etc). */
export async function isIsolatedOnlyAsset(symbol: string): Promise<boolean> {
  const meta = await getAssetMeta(symbol).catch(() => null);
  return !!meta?.onlyIsolated;
}

/**
 * Cross-cycle cache of HL account-abstraction mode per wallet (6h TTL).
 * userAbstraction is a weight-20 info call for a value that essentially
 * never changes; fetching it per wallet per cycle dominated the bundle
 * weight (20 of 24). Stale worst case: a user upgrades legacy → unified and
 * the free-margin formula lags one TTL — mode flips are one-time events and
 * the wrong branch only under/over-estimates opening headroom (orders are
 * still margin-checked by HL itself).
 */
const abstractionCache = new Map<string, { at: number; value: unknown }>();
const ABSTRACTION_TTL_MS = 6 * 60 * 60 * 1000;

async function getCachedAbstraction(user: string): Promise<unknown> {
  const key = user.toLowerCase();
  const hit = abstractionCache.get(key);
  if (hit && Date.now() - hit.at < ABSTRACTION_TTL_MS) return hit.value;
  const value = await withHlRetry(
    () => (info as any).userAbstraction({ user }),
    HL_WEIGHT.userAbstraction,
  ).catch(() => null);
  // Don't cache lookup failures — retry next bundle instead of pinning null.
  if (value != null) abstractionCache.set(key, { at: Date.now(), value });
  return value ?? hit?.value ?? null;
}

/**
 * Dex-scoped metaAndAssetCtxs with a short module cache (mid/funding for
 * HIP-3 assets). 45s TTL: fresh enough for hourly decisions, and one fetch
 * covers every agent + symbol on that dex within a cycle.
 */
const dexCtxsCache = new Map<string, { at: number; data: [any, any[]] }>();
const DEX_CTXS_TTL_MS = 45_000;

async function getDexMetaAndCtxs(dex: string): Promise<[any, any[]]> {
  const hit = dexCtxsCache.get(dex);
  if (hit && Date.now() - hit.at < DEX_CTXS_TTL_MS) return hit.data;
  const data = await hlInfoRaw<[any, any[]]>(
    { type: 'metaAndAssetCtxs', dex },
    HL_WEIGHT.metaAndAssetCtxs,
  );
  dexCtxsCache.set(dex, { at: Date.now(), data });
  return data;
}

/** Universe index of `symbol` within a dex meta (names vary: TSLA vs xyz:TSLA). */
function dexUniverseIndex(universe: Array<{ name?: string }>, dex: string, symbol: string): number {
  const symUpper = symbol.toUpperCase();
  const coinUpper = symUpper.includes(':') ? symUpper.slice(symUpper.indexOf(':') + 1) : symUpper;
  return universe.findIndex((u) => {
    const n = String(u?.name ?? '').toUpperCase();
    return n === symUpper || n === coinUpper || n === `${dex}:${coinUpper}`.toUpperCase();
  });
}

/**
 * Live HL mid for a perp. Exported for the monitor loop: decision prompts
 * must see the REAL market price, not the last (up to 1h stale) CoinGlass
 * bar close. Main dex via cycle-cached allMids; HIP-3 via dex ctxs.
 */
export async function getMidPrice(symbol: string): Promise<number> {
  const dex = symbolDex(symbol);
  if (dex) {
    const [meta, ctxs] = await getDexMetaAndCtxs(dex);
    const idx = dexUniverseIndex(meta?.universe ?? [], dex, symbol);
    const ctx = idx >= 0 ? ctxs?.[idx] : null;
    const px = Number(ctx?.midPx ?? ctx?.markPx);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`No mid price for ${symbol}`);
    return px;
  }
  const cache = cycleCache();
  const mids = cache
    ? await cache.getAllMids(() =>
        withHlRetry(() => info.allMids() as Promise<Record<string, string>>, HL_WEIGHT.allMids),
      )
    : await withHlRetry(() => info.allMids() as Promise<Record<string, string>>, HL_WEIGHT.allMids);
  const px = Number(mids[symbol.toUpperCase()]);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`No mid price for ${symbol}`);
  return px;
}

/**
 * Canonical HL coin name for info queries: main dex upper-case (`BTC`),
 * builder dex `{dex}:{COIN}` with the dex lower-case (`xyz:TSLA`). Agent
 * configs / the monitor loop upper-case whole symbols (`XYZ:TSLA`), which HL
 * does not accept for `l2Book`.
 */
export function hlCoinName(symbol: string): string {
  const i = symbol.indexOf(':');
  if (i > 0) return `${symbol.slice(0, i).toLowerCase()}:${symbol.slice(i + 1).toUpperCase()}`;
  return symbol.toUpperCase();
}

/**
 * L2 book snapshot for a perp (main dex or HIP-3), cycle-cached with an age
 * bound. Never throws — a missing book degrades to "no book context" (the
 * open path then falls back to allMids + static tier slippage).
 */
export async function getBookSnapshot(
  symbol: string,
  maxAgeMs: number = BOOK_PROMPT_MAX_AGE_MS,
): Promise<BookSnapshot | null> {
  const coin = hlCoinName(symbol);
  const fetch = async (): Promise<BookSnapshot | null> => {
    const raw = await withHlRetry(() => info.l2Book({ coin }), HL_WEIGHT.l2Book);
    return parseL2Book(symbol, raw as Parameters<typeof parseL2Book>[1]);
  };
  try {
    const cache = cycleCache();
    return cache ? await cache.getL2Book(coin, fetch, maxAgeMs) : await fetch();
  } catch (err) {
    console.warn(`[hl] l2Book ${coin} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Spread ceiling (bps) for the open gate. Tier defaults reflect normal HL
 * books: BTC/ETH ~1 bp, liquid alts single digits, thin alts tens; HIP-3
 * equities are wide off-session by design. `BOOK_MAX_SPREAD_BPS` overrides.
 */
export function maxSpreadBpsFor(symbol: string): number {
  if (config.bookMaxSpreadBpsOverride != null) return config.bookMaxSpreadBpsOverride;
  if (symbolDex(symbol)) return 100;
  const tier = liquidityTier(symbol);
  if (tier === 'major') return 15;
  if (tier === 'mid') return 35;
  return 80;
}

/**
 * Current / next HL funding rate for a main-dex perp, in bps per funding
 * interval (HL assetCtx.funding is a decimal fraction). Cycle-cached via
 * metaAndAssetCtxs (one call per worker cycle).
 */
export async function getHlFundingBps(symbol: string): Promise<number | null> {
  const dex = symbolDex(symbol);
  if (dex) {
    const [meta, ctxs] = await getDexMetaAndCtxs(dex).catch(() => [null, []] as [any, any[]]);
    const idx = dexUniverseIndex(meta?.universe ?? [], dex, symbol);
    if (idx < 0) return null;
    const funding = Number(ctxs?.[idx]?.funding);
    return Number.isFinite(funding) ? funding * 10_000 : null;
  }
  const cache = cycleCache();
  const fetchCtxs = () =>
    withHlRetry(
      () => (info as any).metaAndAssetCtxs() as Promise<[any, any[]]>,
      HL_WEIGHT.metaAndAssetCtxs,
    );
  const [meta, assetCtxs] = cache
    ? await cache.getMetaAndAssetCtxs(fetchCtxs)
    : await fetchCtxs();
  const universe: { name?: string }[] = meta?.universe ?? [];
  const idx = universe.findIndex(
    (u) => String(u?.name ?? '').toUpperCase() === symbol.toUpperCase(),
  );
  if (idx < 0) return null;
  const funding = Number(assetCtxs?.[idx]?.funding);
  if (!Number.isFinite(funding)) return null;
  return funding * 10_000;
}

export class HlAgentExecutionAdapter {
  private readonly exchange: ExchangeClient;
  private readonly masterAddress: Hex;
  private readonly subaccount: Hex | null;
  private readonly agentConfig: AgentConfig;
  private readonly allowedSymbols: Set<string>;
  /** HIP-3 dexes this agent's symbols touch (usually [] or ['xyz']). */
  private readonly tradedDexes: string[];

  constructor(args: {
    agentPrivateKey: Hex;
    masterAddress: Hex;
    subaccountAddress?: Hex | null;
    agentConfig: AgentConfig;
  }) {
    this.masterAddress = args.masterAddress;
    this.subaccount = args.subaccountAddress ?? null;
    this.agentConfig = args.agentConfig;
    this.allowedSymbols = new Set(args.agentConfig.symbols.map((s) => s.toUpperCase()));
    this.tradedDexes = [
      ...new Set(
        args.agentConfig.symbols
          .map((s) => symbolDex(s))
          .filter((d): d is string => d != null && SUPPORTED_HIP3_DEXES.has(d)),
      ),
    ];
    this.exchange = new ExchangeClient({
      transport,
      wallet: privateKeyToAccount(args.agentPrivateKey),
      // Dedicated mode: all actions target the subaccount's clearinghouse.
      ...(this.subaccount ? { defaultVaultAddress: this.subaccount } : {}),
    });
  }

  /** The address whose clearinghouse state this agent trades against. */
  get tradingAddress(): Hex {
    return this.subaccount ?? this.masterAddress;
  }

  private assertSymbolAllowed(symbol: string): void {
    const dex = symbolDex(symbol);
    if (dex && !SUPPORTED_HIP3_DEXES.has(dex)) {
      throw new Error(`HIP-3 dex not supported: ${dex} (symbol ${symbol})`);
    }
    if (!this.allowedSymbols.has(symbol.toUpperCase())) {
      throw new Error(`Symbol not in agent allowlist: ${symbol}`);
    }
  }

  /**
   * clearinghouseState for one HIP-3 dex (positions + margin used live there
   * even though unified collateral is spot USDC). Short module cache keyed by
   * user|dex; invalidated after our own writes.
   */
  private async loadDexClearinghouse(dex: string): Promise<any> {
    const key = `${this.tradingAddress.toLowerCase()}|${dex}`;
    const hit = dexClearinghouseCache.get(key);
    if (hit && Date.now() - hit.at < DEX_CLEARINGHOUSE_TTL_MS) return hit.data;
    const data = await hlInfoRaw<any>(
      { type: 'clearinghouseState', user: this.tradingAddress, dex },
      HL_WEIGHT.clearinghouseState,
    );
    dexClearinghouseCache.set(key, { at: Date.now(), data });
    return data;
  }

  /**
   * Free collateral available to open/add notional.
   *
   * IMPORTANT: on `unifiedAccount` / `portfolioMargin` (HL app default), USDC
   * lives in the spot pool and perp `clearinghouseState.withdrawable` is often
   * ~0 even with tens of dollars free. Using withdrawable alone falsely
   * skipped opens (`skipped_margin`). Match the app: spot USDC − margin used.
   *
   * `withdrawableUsd` here means "free margin for new opens" (not HL's raw
   * withdrawable field) so existing call sites keep working.
   */
  private async loadWalletBundle(): Promise<{
    clearinghouse: any;
    spot: any | null;
    abstraction: unknown;
  }> {
    const user = this.tradingAddress;
    const fetchBundle = () =>
      Promise.all([
        withHlRetry(() => info.clearinghouseState({ user }), HL_WEIGHT.clearinghouseState),
        withHlRetry(
          () => info.spotClearinghouseState({ user }),
          HL_WEIGHT.spotClearinghouseState,
        ).catch(() => null),
        getCachedAbstraction(user),
        // WEIGHT NOTE (2026-07): userAbstraction costs 20 of the 24-weight
        // bundle but the account mode changes at most once in an account's
        // life (legacy → unified upgrade). It now comes from a cross-cycle
        // 6h cache (getCachedAbstraction) instead of every wallet bundle —
        // that alone ~5×'s how many wallets fit in the HL weight budget.
        // Zero trade impact: the value only picks the free-margin formula
        // (unified vs classic), and a mode flip is detected within one TTL.
        // Original per-bundle fetch kept for reference / easy revert:
        // withHlRetry(
        //   () => (info as any).userAbstraction({ user }),
        //   HL_WEIGHT.userAbstraction,
        // ).catch(() => null),
      ]).then(([clearinghouse, spot, abstraction]) => ({
        clearinghouse,
        spot,
        abstraction,
      }));

    const cache = cycleCache();
    return cache ? cache.getWalletBundle(user, fetchBundle) : fetchBundle();
  }

  private invalidateAfterWrite(): void {
    for (const dex of this.tradedDexes) {
      dexClearinghouseCache.delete(`${this.tradingAddress.toLowerCase()}|${dex}`);
    }
    const cache = cycleCache();
    if (!cache) return;
    cache.invalidateWallet(this.tradingAddress);
    cache.invalidateMids();
  }

  async getBalance(): Promise<{
    accountValueUsd: number;
    withdrawableUsd: number;
    freeMarginUsd: number;
    accountMode: string | null;
  }> {
    const { clearinghouse: state, spot: spotState, abstraction } = await this.loadWalletBundle();

    const accountValue = Number(state.marginSummary?.accountValue ?? 0);
    const totalMarginUsed = Number(state.marginSummary?.totalMarginUsed ?? 0);
    const rawWithdrawable = Number(state.withdrawable ?? 0);
    const classicFree = Math.max(0, accountValue - totalMarginUsed);

    let spotUsdc = 0;
    for (const b of (spotState as any)?.balances ?? []) {
      if (String(b?.coin ?? '').toUpperCase() === 'USDC') {
        spotUsdc = Number(b.total ?? 0);
        break;
      }
    }

    const modeRaw = abstraction;
    const accountMode =
      typeof modeRaw === 'string'
        ? modeRaw
        : modeRaw && typeof modeRaw === 'object'
          ? String((modeRaw as any).type ?? (modeRaw as any).abstraction ?? '') || null
          : null;
    const isUnified =
      accountMode === 'unifiedAccount' || accountMode === 'portfolioMargin';

    // HIP-3 margin lives on each dex's clearinghouse even though unified
    // collateral is spot USDC — without this, xyz positions looked free.
    let dexMarginUsed = 0;
    for (const dex of this.tradedDexes) {
      const dexState = await this.loadDexClearinghouse(dex).catch(() => null);
      const used = Number(dexState?.marginSummary?.totalMarginUsed ?? 0);
      if (Number.isFinite(used)) dexMarginUsed += used;
    }

    // Unified: collateral is spot USDC; subtract init margin already in use.
    // Classic: prefer accountValue − marginUsed (opening room); fall back to
    // withdrawable when that understates (edge cases / transfers).
    const freeMarginUsd = isUnified
      ? Math.max(0, spotUsdc - totalMarginUsed - dexMarginUsed)
      : Math.max(rawWithdrawable, classicFree);

    return {
      accountValueUsd: isUnified ? spotUsdc : accountValue,
      withdrawableUsd: freeMarginUsd,
      freeMarginUsd,
      accountMode,
    };
  }

  /** All open perp positions on the trading address (main dex + traded HIP-3 dexes). */
  async getAllPositions(): Promise<AdapterPosition[]> {
    const { clearinghouse: state } = await this.loadWalletBundle();
    const out: AdapterPosition[] = [...parseClearinghousePositions(state)];
    for (const dex of this.tradedDexes) {
      const dexState = await this.loadDexClearinghouse(dex).catch(() => null);
      if (dexState) out.push(...parseClearinghousePositions(dexState));
    }
    return out;
  }

  async getPosition(symbol: string): Promise<AdapterPosition | null> {
    const all = await this.getAllPositions();
    return all.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  }

  /**
   * Cycle-cached userFills for this trading address (identity + closed PnL).
   * `aggregateByTime: false` — identity needs per-fill cloid + startPosition;
   * aggregating can hide a flatten→manual-reopen gap.
   */
  async getUserFills(): Promise<HlFillLite[]> {
    const user = this.tradingAddress;
    const fetch = () =>
      withHlRetry(
        () => (info as any).userFills({ user, aggregateByTime: false }),
        HL_WEIGHT.userFills,
      ) as Promise<HlFillLite[]>;
    const cache = cycleCache();
    if (cache) return cache.getUserFills(user, fetch);
    return fetch();
  }

  /**
   * True when the live book on `symbol` is still this tracked AI row — not a
   * manual reopen after TP/SL/user flatten. Uses fills (cloid + flat gap) and
   * falls back to entry proximity when fills are unavailable.
   */
  async isTrackedLiveStillOurs(
    tracked: {
      symbol: string;
      direction: 'LONG' | 'SHORT';
      entry_price: number;
      opened_at: string;
      cloid_prefix: string | null;
    },
    live: AdapterPosition,
  ): Promise<boolean> {
    if (live.direction !== tracked.direction) return false;
    const fills = await this.getUserFills().catch(() => null);
    return resolveLiveOwnership({
      fills,
      symbol: tracked.symbol,
      openedAtIso: tracked.opened_at,
      cloidPrefix: tracked.cloid_prefix,
      trackedEntry: tracked.entry_price,
      liveEntry: live.entryPrice,
      sameDirection: true,
    });
  }

  /**
   * Realized PnL for an externally closed tracked position.
   *
   * Prefers summing HL `closedPnl` on fills for this coin since `openedAt`
   * (covers manual close, TP/SL fill, liquidation). Falls back to a mark
   * estimate from entry → mid so Net PnL never drops the close entirely.
   */
  async estimateClosedPnl(args: {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    sizeUsd: number;
    openedAt: string;
  }): Promise<{
    pnlUsd: number;
    closePrice: number | null;
    source: 'fills' | 'mark';
    liquidated: boolean;
  }> {
    const sym = args.symbol.toUpperCase();
    const openedMs = Date.parse(args.openedAt);
    const sinceMs = Number.isFinite(openedMs) ? openedMs - 5_000 : Date.now() - 86_400_000;

    try {
      const fills = await this.getUserFills();

      let sum = 0;
      let fillCount = 0;
      let lastPx: number | null = null;
      let lastT = -1;
      let liquidated = false;
      for (const f of fills ?? []) {
        if (String(f.coin ?? '').toUpperCase() !== sym) continue;
        const t = Number(f.time ?? f.timestamp ?? 0);
        if (Number.isFinite(t) && t > 0 && t < sinceMs) continue;
        const raw = (f as Record<string, unknown>).closedPnl
          ?? (f as Record<string, unknown>).closed_pnl;
        if (raw === undefined || raw === null || raw === '') continue;
        const pnl = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
        if (!Number.isFinite(pnl)) continue;
        // Pure opens report closedPnl=0 — including them made closePrice latch
        // onto entry when fill order wasn't chronological (Circle stop miss).
        if (pnl === 0) continue;
        sum += pnl;
        fillCount += 1;
        const px = Number((f as Record<string, unknown>).px ?? (f as Record<string, unknown>).price ?? 0);
        const fillT = Number.isFinite(t) && t > 0 ? t : -1;
        if (px > 0 && fillT >= lastT) {
          lastPx = px;
          lastT = fillT;
        }
        if (
          (f as Record<string, unknown>).liquidation === true
          || (f as Record<string, unknown>).liquidation === 'true'
        ) {
          liquidated = true;
        }
      }
      if (fillCount > 0) {
        return { pnlUsd: sum, closePrice: lastPx, source: 'fills', liquidated };
      }
    } catch {
      // fall through to mark estimate
    }

    const entry = args.entryPrice;
    const mid = await getMidPrice(sym).catch(() => entry);
    const units =
      entry > 0 && args.sizeUsd > 0 ? args.sizeUsd / entry : 0;
    const pnlUsd =
      args.direction === 'LONG'
        ? (mid - entry) * units
        : (entry - mid) * units;
    return {
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : 0,
      closePrice: Number.isFinite(mid) ? mid : null,
      source: 'mark',
      liquidated: false,
    };
  }

  /**
   * True when the trading book already holds `symbol` and this agent does not
   * own that row. Shared = master wallet; dedicated = that agent's sub.
   * The AI defers to the user — callers must skip opening when this is true.
   */
  async hasUserConflict(symbol: string, agentOwnsPosition: boolean): Promise<boolean> {
    const pos = await this.getPosition(symbol);
    return pos != null && !agentOwnsPosition;
  }

  /** Total notional of positions the agent tracks — enforces notional budget. */
  private async assertCapitalBudget(addNotionalUsd: number, trackedNotionalUsd: number): Promise<void> {
    const budget = notionalBudgetUsd(this.agentConfig, !!this.subaccount);
    if (!(budget > 0)) throw new Error('Agent has no capital budget configured');
    if (trackedNotionalUsd + addNotionalUsd > budget * 1.001) {
      throw new Error(
        `Order rejected by budget cap: tracked $${trackedNotionalUsd.toFixed(2)} + new $${addNotionalUsd.toFixed(2)} > notional budget $${budget}`,
      );
    }
  }

  async openPosition(
    params: OpenParams,
    ctx: { trackedNotionalUsd: number },
  ): Promise<AdapterResult> {
    this.assertSymbolAllowed(params.symbol);
    const leverage = Math.max(1, Math.min(params.leverage, this.agentConfig.leverage_cap));
    await this.assertCapitalBudget(params.sizeUsd, ctx.trackedNotionalUsd);

    const meta = await getAssetMeta(params.symbol);
    const cappedLeverage = Math.min(leverage, meta.maxLeverage);

    // Margin mode from the agent config; not every asset supports cross, so a
    // cross rejection falls back to isolated instead of failing the decision.
    // HIP-3 assets flagged onlyIsolated skip cross outright. Done once — not
    // inside the IOC retry loop.
    const wantCross =
      (this.agentConfig.margin_mode ?? 'cross') === 'cross' && !meta.onlyIsolated;
    try {
      await withHlExchange(() =>
        this.exchange.updateLeverage({
          asset: meta.assetId,
          isCross: wantCross,
          leverage: cappedLeverage,
        }),
      );
    } catch (err) {
      if (!wantCross) throw err;
      await withHlExchange(() =>
        this.exchange.updateLeverage({
          asset: meta.assetId,
          isCross: false,
          leverage: cappedLeverage,
        }),
      );
    }

    const isBuy = params.direction === 'LONG';
    const side: TakeSide = isBuy ? 'buy' : 'sell';

    // ── Maker leg (ALO at the touch, bounded wait) ─────────────────────────
    // Fee math: HL taker 4.5 bps vs maker 1.5 bps base — with the builder fee
    // on top, every maker-filled dollar is ~3 bps cheaper. Needs a fresh book
    // to know the touch; without one we go straight to IOC.
    const wantMaker =
      (params.execution ?? (config.makerFirstOpen ? 'maker_first' : 'ioc')) === 'maker_first';
    let remainingUsd = params.sizeUsd;
    let makerNote = '';
    let makerFilledUnits = 0;
    let iocCloid: Hex | undefined = params.cloid;
    if (wantMaker) {
      const book = await getBookSnapshot(params.symbol, BOOK_EXEC_MAX_AGE_MS);
      if (book) {
        const before = await this.getPosition(params.symbol).catch(() => null);
        const beforeSignedUnits = before
          ? (before.direction === 'LONG' ? 1 : -1) * before.sizeUnits
          : 0;
        const mk = await this.tryMakerOpen({
          symbol: params.symbol,
          meta,
          isBuy,
          book,
          sizeUsd: params.sizeUsd,
          cloid: params.cloid,
          beforeSignedUnits,
        });
        makerNote = mk.note;
        makerFilledUnits = mk.filledUnits;
        if (mk.submitted && params.cloid) iocCloid = deriveSiblingCloid(params.cloid);
        remainingUsd = Math.max(0, params.sizeUsd - mk.filledUnits * mk.px);
        if (mk.filledUnits > 0 && remainingUsd < HL_MIN_ORDER_NOTIONAL_USD) {
          return { ok: true, detail: `maker filled ${mk.filledUnits} @ ${mk.px} [${mk.note}]` };
        }
      } else {
        makerNote = 'no book — ioc only';
      }
    }

    // ── Taker leg (IOC, depth-aware band) ──────────────────────────────────
    // Explicit caller slip wins. Otherwise size the band off the live book
    // (worst level needed ×1.5 + 10 bps, floor 15 bps) and price it off the
    // BOOK mid (seconds old) instead of the cycle-cached allMids (minutes
    // old). Static tier table remains the fallback when no book is available.
    let slip: number | null = params.slippage ?? null;
    let last: AdapterResult = { ok: false, detail: 'open failed' };

    // At most 2 attempts: initial band, then one widen on IOC no-match only.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const book = await getBookSnapshot(params.symbol, attempt === 0 ? BOOK_EXEC_MAX_AGE_MS : 0);
      const mid = book?.mid ?? (await getMidPrice(params.symbol));
      if (slip == null) {
        slip =
          (book ? resolveBookSlippage(book, side, remainingUsd) : null) ??
          resolveOpenSlippage(params.symbol, remainingUsd);
      }
      const px = isBuy ? mid * (1 + slip) : mid * (1 - slip);
      const sizeUnits = remainingUsd / mid;
      const s = formatSize(sizeUnits, meta.szDecimals);
      if (Number(s) <= 0) {
        if (makerFilledUnits > 0) {
          return { ok: true, detail: `maker filled ${makerFilledUnits} [${makerNote}]; remainder rounds to zero` };
        }
        throw new Error(`Order size rounds to zero for ${params.symbol}`);
      }

      const result = await withHlExchange(() =>
        this.exchange.order({
          orders: [
            {
              a: meta.assetId,
              b: isBuy,
              p: formatPrice(px, meta.szDecimals, 'perp'),
              s,
              r: false,
              t: { limit: { tif: 'Ioc' } },
              ...(iocCloid ? { c: iocCloid } : {}),
            },
          ],
          grouping: 'na',
          builder: { b: config.builderAddress as Hex, f: config.builderFeeTenthsBps },
        }),
      );
      this.invalidateAfterWrite();
      last = interpretOrderResult(result);
      const bandTag = `slip=${(slip * 100).toFixed(2)}%${book ? ' book' : ' tier'}`;
      if (last.ok) {
        const legs = makerFilledUnits > 0 ? ` [maker ${makerFilledUnits} + ioc; ${makerNote}]` : makerNote ? ` [${makerNote}]` : '';
        return {
          ok: true,
          detail: `${last.detail} [${attempt > 0 ? 'ioc_retry ' : ''}${bandTag}]${legs}`,
        };
      }
      if (attempt === 0 && isIocNoMatch(last.detail)) {
        const next = widenSlippage(slip);
        if (next > slip + 1e-9) {
          console.warn(
            `[hl] IOC no-match on open ${params.symbol}; retry slip ${(slip * 100).toFixed(2)}%→${(next * 100).toFixed(2)}%`,
          );
          slip = next;
          continue;
        }
      }
      break;
    }
    // A partial maker fill IS a live position — report success so the caller
    // tracks it (it reads the real size/entry from HL) instead of orphaning it.
    if (makerFilledUnits > 0) {
      return {
        ok: true,
        detail: `maker filled ${makerFilledUnits} [${makerNote}]; ioc remainder failed: ${last.detail}`,
      };
    }
    return last;
  }

  /**
   * Post-only open at the touch (buy → best bid, sell → best ask) tagged with
   * the agent cloid, then poll `orderStatus` until filled / gone / timeout.
   * On timeout: cancel, re-read status (cancel can race a fill), and report
   * how much filled so the caller sizes the IOC remainder.
   *
   * Never throws for order-level rejections (e.g. badAloPxRejected when the
   * book moved through our price) — those just mean "no maker fill".
   */
  private async tryMakerOpen(args: {
    symbol: string;
    meta: AssetMeta;
    isBuy: boolean;
    book: BookSnapshot;
    sizeUsd: number;
    cloid?: Hex;
    /** Signed position units before the order (fallback fill settlement). */
    beforeSignedUnits: number;
  }): Promise<{ filledUnits: number; px: number; note: string; submitted: boolean }> {
    const px = args.isBuy ? args.book.bestBid : args.book.bestAsk;
    const s = formatSize(args.sizeUsd / px, args.meta.szDecimals);
    const origUnits = Number(s);
    if (!(origUnits > 0)) return { filledUnits: 0, px, note: 'alo size rounds to zero', submitted: false };
    const pStr = formatPrice(px, args.meta.szDecimals, 'perp');
    const startedAt = Date.now();

    let placed: unknown;
    try {
      placed = await withHlExchange(() =>
        this.exchange.order({
          orders: [
            {
              a: args.meta.assetId,
              b: args.isBuy,
              p: pStr,
              s,
              r: false,
              t: { limit: { tif: 'Alo' } },
              ...(args.cloid ? { c: args.cloid } : {}),
            },
          ],
          grouping: 'na',
          builder: { b: config.builderAddress as Hex, f: config.builderFeeTenthsBps },
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // SDK throws on order-level errors too; a rejected ALO never rested.
      return { filledUnits: 0, px, note: `alo rejected: ${msg.slice(0, 120)}`, submitted: false };
    }
    this.invalidateAfterWrite();

    const status = (placed as { response?: { data?: { statuses?: unknown[] } } })?.response?.data
      ?.statuses?.[0];
    if (!status || typeof status !== 'object') {
      return { filledUnits: 0, px, note: 'alo unexpected status', submitted: true };
    }
    const st = status as Record<string, any>;
    if ('error' in st) {
      return { filledUnits: 0, px, note: `alo rejected: ${String(st.error).slice(0, 120)}`, submitted: false };
    }
    if ('filled' in st) {
      const units = Number(st.filled?.totalSz ?? origUnits) || origUnits;
      return { filledUnits: units, px: Number(st.filled?.avgPx ?? px) || px, note: 'alo filled immediately', submitted: true };
    }
    const oid = Number(st.resting?.oid);
    if (!Number.isFinite(oid)) {
      return { filledUnits: 0, px, note: 'alo resting without oid', submitted: true };
    }

    // ── Wait loop ──────────────────────────────────────────────────────────
    const readStatus = async (): Promise<{ state: string; remaining: number } | null> => {
      const os = (await withHlRetry(
        () => (info as any).orderStatus({ user: this.tradingAddress, oid }),
        HL_WEIGHT.orderStatus,
      ).catch(() => null)) as Record<string, any> | null;
      if (!os || os.status !== 'order') return os ? { state: 'unknown', remaining: origUnits } : null;
      const inner = os.order ?? {};
      const state = String(inner.status ?? 'open');
      const rem = Number(inner.order?.sz);
      const orig = Number(inner.order?.origSz);
      const remaining =
        state === 'filled'
          ? 0
          : Number.isFinite(rem)
            ? rem
            : Number.isFinite(orig)
              ? orig
              : origUnits;
      return { state, remaining };
    };

    let state = 'open';
    let remaining = origUnits;
    const deadline = startedAt + config.makerWaitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(MAKER_POLL_MS, Math.max(250, deadline - Date.now())));
      const snap = await readStatus();
      if (!snap) continue;
      state = snap.state;
      remaining = snap.remaining;
      if (state !== 'open') break;
    }

    // Timed out while resting (or status lookups kept failing / returned
    // unknownOid): cancel defensively — an ALO we lost track of must never
    // stay on the book — then let a final status read settle the fill count.
    if (state === 'open' || state === 'unknown') {
      try {
        await withHlExchange(() =>
          this.exchange.cancel({ cancels: [{ a: args.meta.assetId, o: oid }] }),
        );
      } catch {
        // Already filled / cancelled — the status re-read below is authoritative.
      }
      this.invalidateAfterWrite();
      const finalSnap = await readStatus();
      if (finalSnap && finalSnap.state !== 'unknown') {
        state = finalSnap.state === 'open' ? 'canceled' : finalSnap.state;
        remaining = finalSnap.remaining;
      } else {
        // No authoritative order read. Assuming "nothing filled" risks a
        // double-size position (IOC on top of a fill) — the worse failure —
        // so settle from the position delta instead.
        const after = await this.getPosition(args.symbol).catch(() => null);
        const afterSigned = after ? (after.direction === 'LONG' ? 1 : -1) * after.sizeUnits : 0;
        const delta = (afterSigned - args.beforeSignedUnits) * (args.isBuy ? 1 : -1);
        remaining = Math.max(0, origUnits - Math.max(0, Math.min(origUnits, delta)));
        state = remaining <= 1e-12 ? 'filled' : 'canceled';
      }
    }

    const filledUnits = Math.max(0, Math.min(origUnits, origUnits - remaining));
    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    return {
      filledUnits,
      px,
      note: `alo ${state} ${filledUnits}/${s} @ ${pStr} in ${elapsedS}s`,
      submitted: true,
    };
  }

  /**
   * Cancel resting NON-trigger orders on `symbol` that carry this agent's
   * cloid prefix. A worker crash mid maker-wait would otherwise leave an ALO
   * on the book that fills later into an untracked position. Cheap: reads the
   * cycle-cached open-orders list; only writes when something is found.
   */
  async cancelStaleAgentOrders(symbol: string, cloidPrefix: string): Promise<number> {
    this.assertSymbolAllowed(symbol);
    const orders = await this.listOpenOrdersRaw(symbol).catch(() => [] as Array<Record<string, any>>);
    const sym = symbol.toUpperCase();
    const prefix = cloidPrefix.toLowerCase();
    const stale = orders.filter((o) => {
      if (String(o.coin ?? '').toUpperCase() !== sym) return false;
      const cloid = String(o.cloid ?? '').toLowerCase();
      if (!cloid || !cloid.startsWith(prefix)) return false;
      if (classifyTpslKind(o)) return false;
      if (o.isTrigger === true || o.isPositionTpsl === true) return false;
      return Number.isFinite(Number(o.oid));
    });
    if (!stale.length) return 0;
    const meta = await getAssetMeta(symbol);
    let cancelled = 0;
    for (const o of stale) {
      try {
        await withHlExchange(() =>
          this.exchange.cancel({ cancels: [{ a: meta.assetId, o: Number(o.oid) }] }),
        );
        cancelled += 1;
      } catch {
        // Filled/cancelled meanwhile — nothing to do.
      }
    }
    if (cancelled) {
      this.invalidateAfterWrite();
      console.warn(`[hl] cancelled ${cancelled} stale agent order(s) on ${sym}`);
    }
    return cancelled;
  }

  /**
   * Reduce-only IOC close for `fraction` (1 = full close) of the live position.
   *
   * Exit/cut is critical: retries transient HL failures (429 / network) inside
   * this call so the monitor does not need a second LLM cycle. After each
   * failed attempt we re-read the position — if it's already flat (partial
   * fill / race), we treat that as success.
   */
  async closePosition(symbol: string, fraction = 1): Promise<AdapterResult> {
    this.assertSymbolAllowed(symbol);
    const clamped = Math.min(1, Math.max(0.01, fraction));
    const attempts = clamped >= 0.999 ? 4 : 2; // full exits get more retries
    let lastDetail = 'close failed';
    // Adaptive band (majors 0.5%); widen only after an IOC no-match retry.
    let slip = resolveCloseSlippage(symbol);

    for (let i = 0; i < attempts; i += 1) {
      try {
        const pos = await this.getPosition(symbol);
        if (!pos) {
          return {
            ok: true,
            detail:
              i === 0
                ? 'No open position (already closed)'
                : `Position flat after retry ${i}`,
          };
        }

        const meta = await getAssetMeta(symbol);
        const mid = await getMidPrice(symbol);
        const isBuy = pos.direction === 'SHORT'; // closing direction
        const px = isBuy ? mid * (1 + slip) : mid * (1 - slip);
        const closeUnits = clamped >= 1 ? pos.sizeUnits : pos.sizeUnits * clamped;

        const s = formatSize(closeUnits, meta.szDecimals);
        if (Number(s) <= 0) {
          return { ok: true, detail: 'Trim size rounds to zero (skipped)' };
        }

        const result = await withHlExchange(() =>
          this.exchange.order({
            orders: [
              {
                a: meta.assetId,
                b: isBuy,
                p: formatPrice(px, meta.szDecimals, 'perp'),
                s,
                r: true,
                t: { limit: { tif: 'Ioc' } },
              },
            ],
            grouping: 'na',
            builder: { b: config.builderAddress as Hex, f: config.builderFeeTenthsBps },
          }),
        );
        this.invalidateAfterWrite();
        const interpreted = interpretOrderResult(result);
        if (interpreted.ok) return interpreted;

        lastDetail = interpreted.detail;
        // Soft reject (e.g. insufficient liquidity / reduce-only) — re-check
        // live size; if gone, success. Otherwise retry only if transient-looking.
        const still = await this.getPosition(symbol).catch(() => null);
        if (!still) return { ok: true, detail: `Flat after rejected close: ${lastDetail}` };
        if (isIocNoMatch(lastDetail)) {
          slip = widenSlippage(slip);
        }
        if (!isRetryableCloseDetail(lastDetail) || i === attempts - 1) {
          return { ok: false, detail: lastDetail };
        }
      } catch (err) {
        lastDetail = err instanceof Error ? err.message : String(err);
        const still = await this.getPosition(symbol).catch(() => null);
        if (!still) return { ok: true, detail: `Flat after close error: ${lastDetail}` };
        if (!isHlRateLimitError(err) && !isRetryableCloseDetail(lastDetail)) {
          return { ok: false, detail: lastDetail };
        }
        if (i === attempts - 1) return { ok: false, detail: lastDetail };
      }

      // HL IP 429s often need several seconds; full exits wait longer.
      // IOC no-match uses the shorter backoff (book may refill quickly).
      const backoffMs = (isHlRateLimitError(lastDetail) ? 8_000 : 2_000) * (i + 1)
        + Math.random() * 1_000;
      await sleep(backoffMs);
    }

    return { ok: false, detail: lastDetail };
  }

  async trimPosition(symbol: string, trimPct: number): Promise<AdapterResult> {
    return this.closePosition(symbol, trimPct);
  }

  /** Reduce-only stop-loss trigger linked to the live position. */
  async setStopLoss(symbol: string, stopPrice: number): Promise<AdapterResult> {
    return this.setTpslTrigger(symbol, stopPrice, 'sl');
  }

  /** Reduce-only take-profit trigger linked to the live position. */
  async setTakeProfit(symbol: string, tpPrice: number): Promise<AdapterResult> {
    return this.setTpslTrigger(symbol, tpPrice, 'tp');
  }

  /**
   * Move / set SL safely:
   *   1. Cancel existing SL oids for the coin (HL has no true modify for
   *      positionTpsl — same cancel-then-place path as the app portfolio UI).
   *   2. Place a new position-linked SL (`grouping: positionTpsl`, `s: '0'`).
   *   3. If the new place fails and we knew a prior trigger price, restore it
   *      so a failed edit never leaves the position naked.
   *
   * Callers must already validate never-loosen / no-immediate-trigger.
   */
  async replaceStopLoss(symbol: string, stopPrice: number): Promise<AdapterResult> {
    this.assertSymbolAllowed(symbol);
    const prior = (await this.listTpslOrders(symbol)).find((o) => o.kind === 'sl');
    const priorPx = prior?.triggerPx && prior.triggerPx > 0 ? prior.triggerPx : null;
    await this.cancelTpslKind(symbol, 'sl');
    const placed = await this.setTpslTrigger(symbol, stopPrice, 'sl');
    if (!placed.ok && priorPx != null) {
      await this.setTpslTrigger(symbol, priorPx, 'sl').catch(() => undefined);
    }
    return placed;
  }

  /**
   * Ensure SL/TP triggers exist for an open position. Used after open and on
   * monitor cycles so positions opened before TP support still get a TP.
   * Does NOT replace existing triggers (avoids hourly cancel/replace churn).
   */
  async ensureProtectiveTriggers(
    symbol: string,
    stopPrice: number | null | undefined,
    takeProfit: number | null | undefined,
  ): Promise<void> {
    this.assertSymbolAllowed(symbol);
    const pos = await this.getPosition(symbol);
    if (!pos) return;

    const existing = await this.listTpslOrders(symbol);
    const haveSl = existing.some((o) => o.kind === 'sl');
    const haveTp = existing.some((o) => o.kind === 'tp');
    if (
      Number.isFinite(stopPrice) &&
      (stopPrice as number) > 0 &&
      !haveSl
    ) {
      await this.setStopLoss(symbol, stopPrice as number).catch(() => undefined);
    }
    if (
      Number.isFinite(takeProfit) &&
      (takeProfit as number) > 0 &&
      !haveTp
    ) {
      await this.setTakeProfit(symbol, takeProfit as number).catch(() => undefined);
    }
  }

  /** Cycle-cached frontendOpenOrders for this trading address on `symbol`'s dex. */
  private async listOpenOrdersRaw(symbol: string): Promise<Array<Record<string, any>>> {
    const user = this.tradingAddress;
    const dex = symbolDex(symbol);
    const cache = cycleCache();
    const fetchOrders = () =>
      withHlRetry(
        () => (info as any).frontendOpenOrders({ user, ...(dex ? { dex } : {}) }),
        HL_WEIGHT.frontendOpenOrders,
      ) as Promise<Array<Record<string, any>>>;
    // Cache key must separate dex order books from main; the composite key
    // rides through HlCycleCache's map untyped.
    const cacheKey = (dex ? `${user}|${dex}` : user) as Hex;
    const orders = cache ? await cache.getOpenOrders(cacheKey, fetchOrders) : await fetchOrders();
    return orders ?? [];
  }

  async listTpslOrders(symbol: string): Promise<TpslOpenOrder[]> {
    const out: TpslOpenOrder[] = [];
    try {
      const orders = await this.listOpenOrdersRaw(symbol);
      const sym = symbol.toUpperCase();
      for (const o of orders ?? []) {
        if (String(o.coin ?? '').toUpperCase() !== sym) continue;
        const kind = classifyTpslKind(o);
        if (!kind) continue;
        const oid = Number(o.oid ?? o.order?.oid);
        const triggerPx = Number(
          o.triggerPx ?? o.trigger?.triggerPx ?? o.t?.trigger?.triggerPx ?? o.limitPx ?? 0,
        );
        if (!Number.isFinite(oid)) continue;
        out.push({
          kind,
          oid,
          triggerPx: Number.isFinite(triggerPx) ? triggerPx : null,
          isPositionTpsl: o.isPositionTpsl === true,
        });
      }
    } catch {
      // Callers decide whether to place blindly.
    }
    return out;
  }

  private async cancelTpslKind(symbol: string, kind: 'sl' | 'tp'): Promise<void> {
    const meta = await getAssetMeta(symbol);
    const matches = (await this.listTpslOrders(symbol)).filter((o) => o.kind === kind);
    for (const m of matches) {
      try {
        await withHlExchange(() =>
          this.exchange.cancel({ cancels: [{ a: meta.assetId, o: m.oid }] }),
        );
        this.invalidateAfterWrite();
      } catch {
        // Stale oid (already filled/cancelled) — continue.
      }
    }
  }

  /**
   * Place a position-linked TP/SL trigger.
   *
   * Mirrors frontend `placeReduceOnlyTpslTrigger`:
   *   grouping = 'positionTpsl', s = '0', r = true, isMarket = true
   * so HL binds size to the live position (survives trim/add) and does not
   * flip the user into an opposite position on partial closes.
   */
  private async setTpslTrigger(
    symbol: string,
    triggerPrice: number,
    kind: 'sl' | 'tp',
  ): Promise<AdapterResult> {
    this.assertSymbolAllowed(symbol);
    if (!(Number.isFinite(triggerPrice) && triggerPrice > 0)) {
      return { ok: false, detail: 'Invalid trigger price' };
    }
    const pos = await this.getPosition(symbol);
    if (!pos) return { ok: false, detail: 'No open position to protect' };

    // Reject triggers that would fire immediately (wrong side of market).
    const buffer = Math.max(triggerPrice, pos.entryPrice) * 0.0005; // 5 bps
    if (pos.direction === 'LONG') {
      const mid = await getMidPrice(symbol);
      if (kind === 'sl' && triggerPrice >= mid - buffer) {
        return { ok: false, detail: `SL ${triggerPrice} too close/above market ${mid}` };
      }
      if (kind === 'tp' && triggerPrice <= mid + buffer) {
        return { ok: false, detail: `TP ${triggerPrice} too close/below market ${mid}` };
      }
    } else {
      const mid = await getMidPrice(symbol);
      if (kind === 'sl' && triggerPrice <= mid + buffer) {
        return { ok: false, detail: `SL ${triggerPrice} too close/below market ${mid}` };
      }
      if (kind === 'tp' && triggerPrice >= mid - buffer) {
        return { ok: false, detail: `TP ${triggerPrice} too close/above market ${mid}` };
      }
    }

    const meta = await getAssetMeta(symbol);
    const isBuy = pos.direction === 'SHORT'; // trigger closes the position
    const px = formatPrice(triggerPrice, meta.szDecimals, 'perp');
    const result = await withHlExchange(() =>
      this.exchange.order({
        orders: [
          {
            a: meta.assetId,
            b: isBuy,
            p: px,
            // HL sentinel: s='0' + positionTpsl → close live position size at fire.
            s: '0',
            r: true,
            t: {
              trigger: {
                isMarket: true,
                triggerPx: px,
                tpsl: kind,
              },
            },
          },
        ],
        grouping: 'positionTpsl',
        builder: { b: config.builderAddress as Hex, f: config.builderFeeTenthsBps },
      }),
    );
    this.invalidateAfterWrite();
    return interpretOrderResult(result);
  }
}

export interface TpslOpenOrder {
  kind: 'sl' | 'tp';
  oid: number;
  triggerPx: number | null;
  isPositionTpsl: boolean;
}

function classifyTpslKind(o: Record<string, any>): 'sl' | 'tp' | null {
  const flag = String(
    o.tpsl ?? o.trigger?.tpsl ?? o.t?.trigger?.tpsl ?? o.orderType?.trigger?.tpsl ?? '',
  ).toLowerCase();
  if (flag === 'tp' || flag === 'sl') return flag;
  const orderType = String(o.orderType ?? '').toLowerCase();
  if (orderType.includes('take')) return 'tp';
  if (orderType.includes('stop')) return 'sl';
  return null;
}

/**
 * HL order statuses are heterogeneous:
 *   • { filled: {...} } / { resting: {...} } — normal limit/IOC
 *   • "waitingForTrigger" (string) — accepted TP/SL trigger (common for
 *     positionTpsl). Must NOT use `'error' in status` on a string — that
 *     throws TypeError and falsely marks a successful SL move as failed
 *     (DB stop_loss then stays stale while HL already has the new trigger).
 *   • { error: "..." } — rejection
 */
function interpretOrderResult(result: unknown): AdapterResult {
  const statuses: unknown[] =
    (result as { response?: { data?: { statuses?: unknown[] } } })?.response?.data?.statuses ?? [];
  const first = statuses[0];

  if (typeof first === 'string') {
    const s = first.toLowerCase();
    if (s.includes('error') || s.includes('reject')) {
      return { ok: false, detail: first };
    }
    // waitingForTrigger / similar acceptance strings
    return { ok: true, detail: first };
  }

  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    if ('error' in obj) {
      return { ok: false, detail: String(obj.error) };
    }
    return { ok: true, detail: JSON.stringify(obj).slice(0, 300) };
  }

  // Empty statuses — treat as soft success (some SDK paths omit them).
  return { ok: true, detail: JSON.stringify(result).slice(0, 300) };
}
