/**
 * Asset id + szDecimals — same HIP-3 formula as
 * `getAssetIdAndMeta` in `frontend/src/lib/hyperliquid.ts`:
 *   asset = 100000 + perp_dex_index * 10000 + index_in_meta
 */
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import { getHlInfoClient, getHlTransport, hlInfo } from './clients';

export type AssetMeta = {
  assetId: number;
  szDecimals: number;
  maxLeverage?: number;
  onlyIsolated: boolean;
  supportsCross: boolean;
};

let converterPromise: Promise<SymbolConverter> | null = null;
let metaPromise: Promise<{ universe?: Array<Record<string, unknown>> }> | null = null;
let perpDexsPromise: Promise<unknown[]> | null = null;
const hip3Meta = new Map<string, Promise<{ universe?: Array<Record<string, unknown>> }>>();

async function getMeta() {
  if (!metaPromise) {
    metaPromise = getHlInfoClient()
      .meta()
      .catch((err) => {
        metaPromise = null;
        throw err;
      });
  }
  return metaPromise;
}

async function getConverter() {
  if (!converterPromise) {
    converterPromise = SymbolConverter.create({ transport: getHlTransport() }).catch((err) => {
      converterPromise = null;
      throw err;
    });
  }
  return converterPromise;
}

async function getHip3Meta(dex: string) {
  const key = dex.toLowerCase();
  const existing = hip3Meta.get(key);
  if (existing) return existing;
  const promise = hlInfo<{ universe?: Array<Record<string, unknown>> }>({
    type: 'meta',
    dex: key,
  }).then((json) => {
    if (!json || !Array.isArray(json.universe)) {
      throw new Error(`HIP-3 meta response missing universe for ${key}`);
    }
    return json;
  });
  hip3Meta.set(key, promise);
  promise.catch(() => {
    if (hip3Meta.get(key) === promise) hip3Meta.delete(key);
  });
  return promise;
}

async function getPerpDexs() {
  if (!perpDexsPromise) {
    perpDexsPromise = hlInfo<unknown[]>({ type: 'perpDexs' }).then((json) => {
      if (!Array.isArray(json)) throw new Error('perpDexs response is not an array');
      return json;
    }).catch((err) => {
      perpDexsPromise = null;
      throw err;
    });
  }
  return perpDexsPromise;
}

function isolatedFlags(entry: Record<string, unknown> | undefined): {
  onlyIsolated: boolean;
  supportsCross: boolean;
} {
  const onlyIsolated =
    !!entry?.onlyIsolated ||
    entry?.marginMode === 'strictIsolated' ||
    entry?.marginMode === 'noCross';
  return { onlyIsolated, supportsCross: !onlyIsolated };
}

export async function getAssetIdAndMeta(symbol: string): Promise<AssetMeta> {
  const isHip3 = symbol.includes(':');
  if (isHip3) {
    const dexName = symbol.split(':')[0].toLowerCase();
    const meta = await getHip3Meta(dexName);
    const universe = meta.universe ?? [];
    const assetIndex = universe.findIndex((u) => {
      const n = String(u?.name ?? '');
      return n === symbol || n.toUpperCase() === symbol.toUpperCase();
    });
    if (assetIndex === -1) {
      throw new Error(`Unknown HIP-3 symbol for Hyperliquid: ${symbol}`);
    }
    const dexes = await getPerpDexs();
    const dexIndex = dexes.findIndex((d) => {
      const row = d as { name?: string; dex?: string } | null;
      return row?.name === dexName || row?.dex === dexName;
    });
    if (dexIndex < 0) {
      throw new Error(`Unknown HIP-3 dex for Hyperliquid: ${dexName}`);
    }
    const entry = universe[assetIndex] ?? {};
    const flags = isolatedFlags(entry);
    return {
      assetId: 100000 + dexIndex * 10000 + assetIndex,
      szDecimals: Number(entry.szDecimals ?? 0),
      maxLeverage: Number(entry.maxLeverage),
      ...flags,
    };
  }

  const converter = await getConverter();
  const meta = await getMeta();
  const universe = meta.universe ?? [];
  const normalized = symbol.toUpperCase();
  const aliases = [normalized, normalized.replace(/-PERP$/, ''), normalized.replace(/-USD$/, '')];
  for (const candidate of aliases) {
    const assetId = converter.getAssetId(candidate);
    if (assetId === undefined) continue;
    const entry = universe.find((u) => String(u?.name ?? '') === candidate) ?? {};
    const flags = isolatedFlags(entry);
    return {
      assetId,
      szDecimals: Number(entry.szDecimals ?? converter.getSzDecimals(candidate) ?? 0),
      maxLeverage: Number(entry.maxLeverage),
      ...flags,
    };
  }
  throw new Error(`Unknown symbol for Hyperliquid: ${symbol}`);
}
