/**
 * Phase 1 when ENABLE_COINANK=1.
 *
 * Crypto coins: CoinAnk Plan 2 series (see coinank.ts).
 * HIP-3 (`dex:COIN`): no CoinAnk calls. Massive options + daily bars, earnings,
 * and a single close so the monitor does not skip the symbol. Narratives,
 * catalysts, and the seeded calendar are attached later in the monitor.
 *
 * CoinGlass is not imported for fetching here. The MarketData type is shared.
 */
import { config } from '../config.js';
import type { AgentRow } from '../types.js';
import { isHip3Symbol } from '../brain/assetClass.js';
import { getMidPrice } from '../hl/adapter.js';
import { readGlobalContext, writeGlobalContext } from '../lib/globalCache.js';
import { getDvolOptionsBars, supportsDeribitDvol } from './deribit.js';
import { buildCryptoExtension } from './cryptoExtension.js';
import { getEarningsContext } from './earnings.js';
import { getEquityDailyContext } from './equityDaily.js';
import { getEquityOptionsContext, supportsEquityOptions } from './equityOptions.js';
import { barIntervalMsOf, type CoinglassMarketData } from './coinglass.js';
import {
  fetchCoinankMarketData,
  probeCoinankKeyWithRetry,
} from './coinank.js';
import {
  barIntervalForAgent,
  marketDataCacheKey,
  type MarketDataCache,
  type ValidCoinglassKeys,
} from './marketCache.js';

const MEMOS_KEY = 'coinank_memos_v1';
const MEMOS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_MS = 24 * 60 * 60 * 1000;

interface CoinankMemos {
  swapVenues: Record<string, string>;
  spotVenues: Record<string, string>;
  spotMissing: Record<string, number>;
  perpMissing: Record<string, number>;
}

const emptyMemos = (): CoinankMemos => ({
  swapVenues: {},
  spotVenues: {},
  spotMissing: {},
  perpMissing: {},
});

function fresh(at: number | undefined): boolean {
  return at != null && Date.now() - at < MISS_MS;
}

async function hip3Shell(sym: string): Promise<CoinglassMarketData | null> {
  const daily = supportsEquityOptions(sym) ? await getEquityDailyContext(sym).catch(() => null) : null;
  const equityOptions = supportsEquityOptions(sym)
    ? await getEquityOptionsContext(sym, daily?.close ?? null).catch(() => null)
    : null;
  let px = daily?.close ?? null;
  if (px == null || !(px > 0)) {
    try {
      px = await getMidPrice(sym);
    } catch (err) {
      console.warn(
        `[coinank] ${sym}: no Massive close and no HL mid — soft skip`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  const earnings = await getEarningsContext(sym).catch(() => null);
  return {
    symbol: sym,
    fetchedAt: new Date().toISOString(),
    barIntervalMs: barIntervalMsOf('1h'),
    // One close so lastCloseBar passes. OI / flow / funding / liq stay empty
    // so the composite does not pretend a CEX stock book exists. Live price
    // is still the HL mid in the monitor.
    futures: { timeSeries: [{ timestamp: Date.now(), close_price: px }] },
    spot: { timeSeries: [] },
    options: { timeSeries: [] },
    equityOptions,
    equityDaily: daily,
    earnings,
  };
}

export async function buildCoinankSymbolCache(agents: AgentRow[]): Promise<{
  marketData: MarketDataCache;
  validKeys: ValidCoinglassKeys;
  keysLabel: string;
}> {
  const marketData: MarketDataCache = new Map();
  const validKeys: ValidCoinglassKeys = new Set();
  const apiKey = config.coinankApiKey;
  if (!apiKey) {
    console.error('[phase1] ENABLE_COINANK=1 but COINANK_API_KEY missing — no market data this cycle');
    return { marketData, validKeys, keysLabel: 'coinank key missing' };
  }
  if (!(await probeCoinankKeyWithRetry(apiKey))) {
    console.error('[phase1] CoinAnk key failed probe — no market data this cycle');
    return { marketData, validKeys, keysLabel: 'coinank key failed' };
  }

  const memos = (await readGlobalContext<CoinankMemos>(MEMOS_KEY).catch(() => null)) ?? emptyMemos();
  memos.swapVenues ??= {};
  memos.spotVenues ??= {};
  memos.spotMissing ??= {};
  memos.perpMissing ??= {};

  const needed = new Map<string, { sym: string; interval: ReturnType<typeof barIntervalForAgent> }>();
  for (const agent of agents) {
    for (const symbol of agent.config.symbols ?? []) {
      const sym = symbol.toUpperCase();
      const interval = barIntervalForAgent(sym, agent.config.horizon);
      needed.set(marketDataCacheKey(sym, interval), { sym, interval });
    }
  }

  for (const { sym, interval } of needed.values()) {
    const cacheKey = marketDataCacheKey(sym, interval);
    if (isHip3Symbol(sym)) {
      const shell = await hip3Shell(sym);
      if (shell) marketData.set(cacheKey, shell);
      continue;
    }
    if (fresh(memos.perpMissing[sym])) {
      console.log(`[coinank] ${sym}: perp miss memo — skipping for 24h`);
      continue;
    }
    const optionsBars = supportsDeribitDvol(sym)
      ? await getDvolOptionsBars(sym).catch(() => [])
      : [];
    try {
      const hit = await fetchCoinankMarketData({
        hlCoin: sym,
        apiKey,
        optionsBars,
        interval,
        swapVenue: memos.swapVenues[sym] ?? null,
        spotVenue: memos.spotVenues[sym] ?? null,
        skipSpot: fresh(memos.spotMissing[sym]),
      });
      if (hit.swapVenue) {
        memos.swapVenues[sym] = hit.swapVenue;
        delete memos.perpMissing[sym];
      } else {
        memos.perpMissing[sym] = Date.now();
      }
      if (hit.spotMiss) {
        memos.spotMissing[sym] = Date.now();
        delete memos.spotVenues[sym];
      } else if (hit.spotVenue) {
        memos.spotVenues[sym] = hit.spotVenue;
        delete memos.spotMissing[sym];
      }
      if (!hit.data) continue;
      hit.data.cryptoExtension = await buildCryptoExtension(
        sym,
        hit.data.futures?.timeSeries ?? [],
      ).catch(() => null);
      marketData.set(cacheKey, hit.data);
    } catch (err) {
      console.error(
        `[phase1] CoinAnk market data failed for ${sym} (${interval}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await writeGlobalContext(MEMOS_KEY, memos, MEMOS_TTL_MS).catch(() => undefined);
  return { marketData, validKeys, keysLabel: 'coinank key ok' };
}
