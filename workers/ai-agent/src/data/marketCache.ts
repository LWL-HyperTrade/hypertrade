/**
 * Phase-1 market-data builder — 1 full CoinGlass series fetch per symbol.
 *
 * Two modes (COINGLASS_GLOBAL_MODE env, see config.ts):
 *   • GLOBAL (CoinGlass Standard house key, 300 req/min): every active
 *     agent's symbols are fetched with the house key; users need no personal
 *     key; the monitor's entitlement check is bypassed. ~8 GETs/symbol at
 *     240/min pace → the full crypto universe fits in a couple of minutes.
 *   • BYOK (legacy/revert): every agent must have a decryptable, working
 *     CoinGlass key. Junk/missing keys never receive market data and never
 *     trigger house-paid LLM opens. Fetch key = house key when set, else the
 *     first user key that passed the cheap probe for that symbol.
 *
 * Either way: full series runs once per unique HL coin per cycle; all
 * entitled agents share the snapshot via cache key = SYMBOL. Venue memos
 * persist across cycles via global_context_cache (see persistMemos).
 */
import { config } from '../config.js';
import { decryptSecret } from '../lib/crypto.js';
import type { AgentRow } from '../types.js';
import { isCryptoAsset } from '../brain/assetClass.js';
import { normalizeHorizon } from '../brain/horizon.js';
import {
  exportCoinglassMemos,
  fetchMarketData,
  hydrateCoinglassMemos,
  probeCoinglassKey,
  probeCoinglassKeyWithRetry,
  INTERVAL_MS,
  type BarInterval,
  type CoinglassMarketData,
  type CoinglassMemoSnapshot,
} from './coinglass.js';
import { readGlobalContext, writeGlobalContext } from '../lib/globalCache.js';
import { getDvolOptionsBars, supportsDeribitDvol } from './deribit.js';
import { getEtfFlowsContext, supportsEtfFlows } from './etfFlows.js';
import { getOptionsPositioning } from './optionsPositioning.js';
import { getEmaContext, wantsEmaContext } from './emaList.js';
import { buildCryptoExtension } from './cryptoExtension.js';
import { getEarningsContext } from './earnings.js';
import { getEquityOptionsContext, supportsEquityOptions } from './equityOptions.js';
import { getEquityDailyContext } from './equityDaily.js';

/** Keyed by `marketDataCacheKey(symbol, interval)` — NOT plain symbol. */
export type MarketDataCache = Map<string, CoinglassMarketData>;

/**
 * Crypto scalpers read 30m bars ("sharper eye" at the same hourly cadence —
 * flag windows are ×2 at compute time so wall-clock lookbacks hold). HIP-3
 * and slower horizons stay on 1h. Both the builder and the per-agent lookup
 * derive the interval through THIS function so they can never disagree.
 */
export function barIntervalForAgent(symbol: string, horizon: unknown): BarInterval {
  return isCryptoAsset(symbol) && normalizeHorizon(horizon) === 'scalper' ? '30m' : '1h';
}

export function marketDataCacheKey(symbol: string, interval: BarInterval): string {
  return `${symbol.toUpperCase()}|${interval}`;
}

/** Keys that passed probe this cycle — used by the monitor for entitlement. */
export type ValidCoinglassKeys = Set<string>;

const CATCHUP_POLL_MS = 90_000;
/** Same-cycle retry after a hard/soft CoinGlass miss (before the slower bar catch-up). */
const FETCH_RETRY_DELAY_MS = 10_000;
const FETCH_MAX_ATTEMPTS = 2;

/**
 * HIP-3 symbols CoinGlass turned out not to list (e.g. TSLAUSDC, verified
 * live 2026-07-20) — go straight to HL-native candles for 24h instead of
 * burning a failing CoinGlass GET + error log every cycle.
 */
const cgMissingHip3Memo = new Map<string, number>();
const CG_MISSING_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Venue/miss memos survive redeploys via global_context_cache — otherwise
 * every deploy replays the full spot-probe error burst for known-missing
 * pairs (observed after each of the 07-20/07-21 deploys).
 */
const MEMOS_CACHE_KEY = 'coinglass_memos_v1';
const MEMOS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let memosHydrated = false;

interface PersistedMemos extends CoinglassMemoSnapshot {
  cgMissingHip3: Record<string, number>;
}

async function hydratePersistedMemos(): Promise<void> {
  if (memosHydrated) return;
  memosHydrated = true;
  const snap = await readGlobalContext<PersistedMemos>(MEMOS_CACHE_KEY);
  if (!snap) return;
  hydrateCoinglassMemos(snap);
  for (const [sym, at] of Object.entries(snap.cgMissingHip3 ?? {})) {
    if (Number.isFinite(at) && !cgMissingHip3Memo.has(sym)) cgMissingHip3Memo.set(sym, at);
  }
}

async function persistMemos(): Promise<void> {
  const snap: PersistedMemos = {
    ...exportCoinglassMemos(),
    cgMissingHip3: Object.fromEntries(cgMissingHip3Memo),
  };
  await writeGlobalContext(MEMOS_CACHE_KEY, snap, MEMOS_TTL_MS);
}

/**
 * A symbol is "current" for this cycle when its series contains a
 * close-bearing bar for the bar that just closed (open ts ≥ window start −
 * one interval). CoinGlass usually also includes the in-progress bar, which
 * trivially satisfies this.
 */
function isSymbolCurrent(data: CoinglassMarketData, windowStartTs: number): boolean {
  const bars = data.futures?.timeSeries ?? [];
  const barMs = data.barIntervalMs ?? INTERVAL_MS;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const b = bars[i];
    if (Number.isFinite(b?.close_price as number)) {
      return b.timestamp >= windowStartTs - barMs;
    }
  }
  return false;
}

export async function buildSymbolCache(agents: AgentRow[]): Promise<{
  marketData: MarketDataCache;
  validKeys: ValidCoinglassKeys;
  /** Cycle log: house-key status in global mode, BYOK probe count otherwise. */
  keysLabel: string;
}> {
  if (config.coinankMode) {
    const { buildCoinankSymbolCache } = await import('./coinankCache.js');
    return buildCoinankSymbolCache(agents);
  }
  const globalMode = config.coinglassGlobalMode;
  const marketData: MarketDataCache = new Map();
  const validKeys: ValidCoinglassKeys = new Set();
  const byokKeysLabel = (): string => `${validKeys.size} valid CoinGlass key(s)`;
  const houseKey = config.coinglassHouseKey;
  // Once per process: reload venue/miss memos so redeploys don't re-probe.
  await hydratePersistedMemos().catch(() => undefined);

  // ── Global-cache mode (CoinGlass Standard house key) ──────────────────────
  // Every active agent's symbols are fetched with the house key; no per-user
  // probes, no entitlement. The monitor bypasses its key check via the same
  // config flag. BYOK below is preserved for revert.
  const keyToSymbols = new Map<string, Set<string>>();
  // (symbol, interval) pairs — the same symbol can be wanted at two intervals
  // when a crypto scalper and a slower-horizon agent (different masters)
  // share it; each interval is its own fetch + cache entry.
  const neededPairs = new Map<string, { sym: string; interval: BarInterval }>();
  const addPair = (symbol: string, horizon: unknown): void => {
    const sym = symbol.toUpperCase();
    const interval = barIntervalForAgent(sym, horizon);
    neededPairs.set(marketDataCacheKey(sym, interval), { sym, interval });
  };
  // BYOK: pairs recorded per agent, kept only when that agent's key probed OK.
  const byokPairs: { apiKey: string; symbol: string; horizon: unknown }[] = [];

  if (globalMode) {
    if (!houseKey) {
      console.error('[phase1] COINGLASS_GLOBAL_MODE=1 but COINGLASS_HOUSE_KEY missing — no market data this cycle');
      return { marketData, validKeys, keysLabel: 'house key missing' };
    }
    if (!(await probeCoinglassKeyWithRetry(houseKey))) {
      console.error('[phase1] house CoinGlass key failed probe — no market data this cycle');
      return { marketData, validKeys, keysLabel: 'house key failed' };
    }
    for (const agent of agents) {
      for (const symbol of agent.config.symbols ?? []) {
        addPair(symbol, agent.config.horizon);
      }
    }
  } else {
    // ── BYOK mode: collect unique keys + which symbols each key wants ──────
    for (const agent of agents) {
      if (!agent.coinglass_key_ciphertext) continue;
      let apiKey: string;
      try {
        apiKey = decryptSecret(agent.coinglass_key_ciphertext);
      } catch {
        continue;
      }
      if (!apiKey) continue;
      let set = keyToSymbols.get(apiKey);
      if (!set) {
        set = new Set();
        keyToSymbols.set(apiKey, set);
      }
      for (const symbol of agent.config.symbols ?? []) {
        set.add(symbol.toUpperCase());
        byokPairs.push({ apiKey, symbol, horizon: agent.config.horizon });
      }
    }

    // Probe each unique key once (cheap). Failures stay out of validKeys.
    for (const apiKey of keyToSymbols.keys()) {
      // Sequential probes keep CoinGlass hobbyist limits calm when many keys.
      const ok = await probeCoinglassKey(apiKey);
      if (ok) validKeys.add(apiKey);
    }

    // Pairs that at least one valid key requested.
    for (const p of byokPairs) {
      if (!validKeys.has(p.apiKey)) continue;
      addPair(p.symbol, p.horizon);
    }
  }

  // House key is fetch-only in BYOK mode — never grants agent entitlement.
  let houseKeyOk: boolean | null = globalMode ? true : null;

  const resolveFetchKey = async (sym: string): Promise<string | null> => {
    // Prefer house key for the heavy pull; else first valid user key that wants this symbol.
    if (houseKey) {
      if (houseKeyOk === null) {
        houseKeyOk = await probeCoinglassKeyWithRetry(houseKey);
      }
      if (houseKeyOk) return houseKey;
    }
    for (const [apiKey, syms] of keyToSymbols) {
      if (validKeys.has(apiKey) && syms.has(sym)) return apiKey;
    }
    return null;
  };

  /**
   * One CoinGlass pull + enrichment. Returns:
   *   'ok'           — cached in marketData
   *   'soft_miss'    — tried CG, no usable OHLC (retry-worthy)
   *   'hard_fail'    — throw/transport (retry-worthy)
   *   'skip_known'   — HIP-3 known-absent memo; do not retry / burn GETs
   */
  const fetchSymbolOnce = async (
    sym: string,
    interval: BarInterval,
    fetchKey: string,
    optionsBars: Awaited<ReturnType<typeof getDvolOptionsBars>>,
  ): Promise<'ok' | 'soft_miss' | 'hard_fail' | 'skip_known'> => {
    const hip3 = sym.includes(':');
    const cgMissAt = hip3 ? cgMissingHip3Memo.get(sym) : undefined;
    const skipCoinglass =
      cgMissAt != null && Date.now() - cgMissAt < CG_MISSING_RECHECK_MS;
    if (skipCoinglass) return 'skip_known';

    try {
      const data = await fetchMarketData({
        hlCoin: sym,
        apiKey: fetchKey,
        optionsBars,
        interval,
      });
      if (!data) {
        // NO HL-candle fallback by design (product 2026-07-20) — skip rather
        // than trade on thin context. Caller may retry once before memoizing.
        console.warn(`[phase1] market data soft-skipped for ${sym} (no usable futures OHLC)`);
        return 'soft_miss';
      }
      if (hip3) cgMissingHip3Memo.delete(sym);
      // Daily spot-ETF flows — BTC/ETH/SOL/XRP only (globally cached, 6h TTL,
      // so this is usually a Supabase read, not a CoinGlass call). Best-effort.
      if (supportsEtfFlows(sym)) {
        data.etfFlows = await getEtfFlowsContext(sym, fetchKey).catch(() => null);
      }
      // Options positioning — BTC/ETH only, globally cached (1h TTL), so this
      // is usually a Supabase read. Best-effort.
      if (supportsDeribitDvol(sym)) {
        data.optionsPositioning = await getOptionsPositioning(sym).catch(() => null);
      }
      // HIP-3 trend EMAs + equity earnings — globally cached / Supabase reads.
      if (wantsEmaContext(sym)) {
        data.ema = await getEmaContext(sym).catch(() => null);
      }
      // Crypto stretch / exhaustion — RSI list + EMA resolve + local pctls.
      // isCryptoAsset-gated inside buildCryptoExtension (HIP-3 equities skip).
      if (isCryptoAsset(sym)) {
        data.cryptoExtension = await buildCryptoExtension(
          sym,
          data.futures?.timeSeries ?? [],
        ).catch(() => null);
      }
      data.earnings = await getEarningsContext(sym).catch(() => null);
      // Listed US options chain (Massive) — equity HIP-3 only, globally
      // cached (30min TTL) so this is usually a Supabase read. Spot hint =
      // last futures close, good enough to center the strike window.
      if (supportsEquityOptions(sym)) {
        const bars = data.futures?.timeSeries ?? [];
        let lastClose: number | null = null;
        for (let i = bars.length - 1; i >= 0; i -= 1) {
          const c = Number(bars[i]?.close_price);
          if (Number.isFinite(c) && c > 0) {
            lastClose = c;
            break;
          }
        }
        data.equityOptions = await getEquityOptionsContext(sym, lastClose).catch(() => null);
        // Real US daily closes (Massive aggs) — the PRIMARY trend basis for
        // equity/metals theses; perp candles are young/thin. Cached 6h.
        data.equityDaily = await getEquityDailyContext(sym).catch(() => null);
      }
      // Cache by SYMBOL+INTERVAL — all entitled agents on that interval share it.
      marketData.set(marketDataCacheKey(sym, interval), data);
      return 'ok';
    } catch (err) {
      // Unexpected transport/parse errors only — series gaps are soft inside fetchMarketData.
      console.error(
        `[phase1] market data failed for ${sym} (${interval}):`,
        err instanceof Error ? err.message : err,
      );
      return 'hard_fail';
    }
  };

  const fetchSymbol = async (
    sym: string,
    interval: BarInterval,
    fetchKey: string,
  ): Promise<void> => {
    const hip3 = sym.includes(':');
    // Deribit DVOL only exists for BTC/ETH — skip the call (and any cache
    // lookup) for other symbols so HYPE/SOL/etc. don't touch Deribit at all.
    const optionsBars = supportsDeribitDvol(sym)
      ? await getDvolOptionsBars(sym).catch(() => [])
      : [];

    let outcome = await fetchSymbolOnce(sym, interval, fetchKey, optionsBars);
    for (let attempt = 2; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
      if (outcome === 'ok' || outcome === 'skip_known') break;
      console.warn(
        `[phase1] ${sym} CoinGlass ${outcome} — retry ${attempt}/${FETCH_MAX_ATTEMPTS} in ${FETCH_RETRY_DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
      outcome = await fetchSymbolOnce(sym, interval, fetchKey, optionsBars);
    }

    // Memoize HIP-3 absence only after retries exhausted — a one-off glitch
    // shouldn't lock the symbol out of CoinGlass for 24h.
    if (outcome === 'soft_miss' && hip3) {
      cgMissingHip3Memo.set(sym, Date.now());
    }
  };

  const fetchKeyByPair = new Map<string, { sym: string; interval: BarInterval; key: string }>();
  for (const { sym, interval } of neededPairs.values()) {
    const fetchKey = await resolveFetchKey(sym);
    if (!fetchKey) continue;
    fetchKeyByPair.set(marketDataCacheKey(sym, interval), { sym, interval, key: fetchKey });
    await fetchSymbol(sym, interval, fetchKey);
  }

  // ── Bar catch-up: never miss a decision because CoinGlass is a few minutes
  // late emitting the new bar. Re-poll only the lagging symbols until they
  // carry the just-closed bar or the budget runs out — a slightly late cycle
  // beats an idle hour. (Monitors also start late, but they read live HL mids
  // when they run, so a few minutes cost nothing.)
  const maxWaitMs = config.barCatchupMaxMinutes * 60_000;
  if (maxWaitMs > 0) {
    const windowStartTs = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
    const deadline = Date.now() + maxWaitMs;
    const lagging = (): string[] =>
      [...fetchKeyByPair.keys()].filter((cacheKey) => {
        const pair = fetchKeyByPair.get(cacheKey)!;
        // CoinGlass-absent HIP-3 symbols are skipped-by-design, not lagging —
        // don't burn the catch-up budget polling a pair that doesn't exist.
        if (cgMissingHip3Memo.has(pair.sym)) return false;
        const d = marketData.get(cacheKey);
        return !d || !isSymbolCurrent(d, windowStartTs);
      });

    let behind = lagging();
    while (behind.length > 0 && Date.now() + CATCHUP_POLL_MS <= deadline) {
      console.warn(
        `[phase1] ${behind.length} series missing the new bar (${behind.join(', ')}) — retrying in ${CATCHUP_POLL_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, CATCHUP_POLL_MS));
      for (const cacheKey of behind) {
        const pair = fetchKeyByPair.get(cacheKey)!;
        await fetchSymbol(pair.sym, pair.interval, pair.key);
      }
      behind = lagging();
    }
    if (behind.length > 0) {
      console.warn(
        `[phase1] bar catch-up budget exhausted — proceeding with previous bar for: ${behind.join(', ')}`,
      );
    }
  }

  // Persist venue/miss memos so the next deploy starts warm (best-effort).
  await persistMemos().catch(() => undefined);

  return {
    marketData,
    validKeys,
    keysLabel: globalMode ? 'house key ok' : byokKeysLabel(),
  };
}
