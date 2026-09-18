/**
 * Spot meta, orders, and USDC class transfer — slim port of
 * `frontend/src/lib/hyperliquid.ts` (resolveSpotSymbol / placeSpotOrder /
 * transferUsdBetweenSpotAndPerp).
 */
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { createAgentExchangeClient, hlInfo, withUserSignedExchange } from './clients';
import { extractHlOid, getPerpOrderAcceptanceError, makeTenantCloid } from './cloid';
import { clampTenantFeeTenths, orderBuilderAddress, type Hex } from './constants';
import type { Eip1193Provider } from './wallet';
import type { PlaceDeskOrderResult } from './placeOrder';

const SPOT_BASE_ALIASES: Record<string, string> = {
  GOLDSPOT: 'XAUT',
};

const MIN_ORDER_USD = 10;

type SpotMetaBlob = [
  {
    universe?: Array<{ name?: string; index?: number; tokens?: number[]; szDecimals?: number }>;
    tokens?: Array<{
      name?: string;
      index?: number;
      szDecimals?: number;
      tokenId?: string;
      weiDecimals?: number;
    }>;
  },
  Array<Record<string, unknown>>,
];

let metaCache: { at: number; data: SpotMetaBlob } | null = null;

async function getSpotMetaAndAssetCtxs(): Promise<SpotMetaBlob> {
  const now = Date.now();
  if (metaCache && now - metaCache.at < 60_000) return metaCache.data;
  const data = await hlInfo<SpotMetaBlob>({ type: 'spotMetaAndAssetCtxs' });
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('Failed to load spot metadata');
  }
  metaCache = { at: now, data };
  return data;
}

function aliasBase(raw: string): string {
  const u = raw.toUpperCase();
  return SPOT_BASE_ALIASES[u] ?? u;
}

export async function resolveSpotSymbol(baseOrPair: string): Promise<string> {
  const data = await getSpotMetaAndAssetCtxs();
  const meta = data[0];
  const universe = meta?.universe ?? [];
  const tokens = meta?.tokens ?? [];
  const universeNames = new Set(universe.map((u) => String(u?.name ?? '').toUpperCase()));

  const raw = aliasBase(String(baseOrPair ?? '').replace(/\/USDC$/i, ''));

  if (universeNames.has(raw)) return raw;
  const direct = raw.includes('/') ? raw : `${raw}/USDC`;
  if (universeNames.has(direct)) return direct;

  const prefixed = raw.startsWith('U') ? raw : `U${raw}`;
  const prefixedPair = prefixed.includes('/') ? prefixed : `${prefixed}/USDC`;
  if (universeNames.has(prefixedPair)) return prefixedPair;

  const unprefixed = raw.startsWith('U') ? raw.slice(1) : raw;
  const unprefixedPair = unprefixed.includes('/') ? unprefixed : `${unprefixed}/USDC`;
  if (universeNames.has(unprefixedPair)) return unprefixedPair;

  const usdcIndex = tokens.find((t) => String(t?.name ?? '').toUpperCase() === 'USDC')?.index;
  const ru = String(raw).toUpperCase();
  const candidateNames: string[] = [];
  if (ru.startsWith('U')) {
    candidateNames.push(ru, ru.length > 1 ? ru.slice(1) : '');
  } else {
    candidateNames.push(`U${ru}`, ru);
  }
  candidateNames.push(ru.startsWith('W') ? ru.slice(1) : `W${ru}`);
  const uniqueCandidates = [...new Set(candidateNames.filter(Boolean).map((v) => v.toUpperCase()))];

  let baseIndex: number | null = null;
  for (const name of uniqueCandidates) {
    const token = tokens.find((t) => String(t?.name ?? '').toUpperCase() === name);
    if (token && Number.isFinite(token.index)) {
      baseIndex = token.index as number;
      break;
    }
  }
  if (baseIndex == null) {
    for (const name of uniqueCandidates) {
      const token = tokens.find((t) => {
        const tName = String(t?.name ?? '').toUpperCase();
        return tName.startsWith(name) && tName.length <= name.length + 1;
      });
      if (token && Number.isFinite(token.index)) {
        baseIndex = token.index as number;
        break;
      }
    }
  }

  if (Number.isFinite(usdcIndex) && Number.isFinite(baseIndex)) {
    const entry = universe.find(
      (u) =>
        Array.isArray(u?.tokens) &&
        u.tokens.length >= 2 &&
        u.tokens[0] === baseIndex &&
        u.tokens[1] === usdcIndex,
    );
    if (entry?.name) return String(entry.name).toUpperCase();
  }

  throw new Error(`Spot market not found for ${baseOrPair}`);
}

export async function getSpotAssetIdAndMeta(
  spotSymbol: string,
): Promise<{ assetId: number; szDecimals: number; pxDecimals?: number }> {
  const data = await getSpotMetaAndAssetCtxs();
  const meta = data[0];
  const assetCtxs = data[1] ?? [];
  const universe = meta?.universe ?? [];
  const tokens = meta?.tokens ?? [];
  const idx = universe.findIndex((u) => String(u?.name ?? '').toUpperCase() === spotSymbol.toUpperCase());
  if (idx < 0) throw new Error(`Spot symbol not found: ${spotSymbol}`);
  const entry = universe[idx] ?? {};
  const entryIndex = Number(entry?.index);
  const ctx = assetCtxs.find((c) => String(c?.coin ?? '').toUpperCase() === spotSymbol.toUpperCase()) ?? {};
  const baseTokenIndex = Array.isArray(entry?.tokens) ? entry.tokens[0] : undefined;
  const token = tokens.find((t) => t?.index === baseTokenIndex) ?? {};
  const entrySzDecimals = Number(entry?.szDecimals);
  const ctxSzDecimals = Number(ctx?.szDecimals);
  const tokenSzDecimals = Number(token?.szDecimals);
  const szDecimals = Number.isFinite(entrySzDecimals)
    ? entrySzDecimals
    : Number.isFinite(ctxSzDecimals)
      ? ctxSzDecimals
      : Number.isFinite(tokenSzDecimals)
        ? tokenSzDecimals
        : 0;
  const assetId = 10000 + (Number.isFinite(entryIndex) ? entryIndex : idx);
  const entryPx = Number((entry as { pxDecimals?: number }).pxDecimals);
  const ctxPx = Number(ctx?.pxDecimals);
  const pxDecimals = Number.isFinite(entryPx) ? entryPx : Number.isFinite(ctxPx) ? ctxPx : undefined;
  return { assetId, szDecimals, pxDecimals };
}

export type SpotAssetData = {
  spotSymbol: string;
  markPx?: number;
  midPx?: number;
  assetId: number;
  szDecimals: number;
  pxDecimals?: number;
  baseCoin?: string;
};

export async function getSpotAssetData(baseSymbolOrPair: string): Promise<SpotAssetData> {
  const spotSymbol = await resolveSpotSymbol(baseSymbolOrPair);
  const data = await getSpotMetaAndAssetCtxs();
  const meta = data[0];
  const assetCtxs = data[1] ?? [];
  const universe = meta?.universe ?? [];
  const tokens = meta?.tokens ?? [];
  const idx = universe.findIndex((u) => String(u?.name ?? '').toUpperCase() === spotSymbol.toUpperCase());
  if (idx < 0) throw new Error(`Spot symbol not found: ${spotSymbol}`);
  const ctx =
    assetCtxs.find((c) => String(c?.coin ?? '').toUpperCase() === spotSymbol.toUpperCase()) ??
    assetCtxs[idx] ??
    {};
  const entry = universe[idx] ?? {};
  const baseTokenIndex = Array.isArray(entry?.tokens) ? entry.tokens[0] : undefined;
  const token = tokens.find((t) => t?.index === baseTokenIndex) ?? {};
  const { assetId, szDecimals, pxDecimals } = await getSpotAssetIdAndMeta(spotSymbol);
  return {
    spotSymbol,
    markPx: Number(ctx?.markPx),
    midPx: Number(ctx?.midPx),
    assetId,
    szDecimals,
    pxDecimals,
    baseCoin: token?.name ? String(token.name).toUpperCase() : undefined,
  };
}

export async function spotTokenWire(coin: string): Promise<string> {
  const data = await getSpotMetaAndAssetCtxs();
  const tokens = data[0]?.tokens ?? [];
  const want = aliasBase(coin);
  const token =
    tokens.find((t) => String(t?.name ?? '').toUpperCase() === want) ??
    tokens.find((t) => String(t?.name ?? '').toUpperCase() === coin.toUpperCase());
  if (!token?.name || !token.tokenId) {
    throw new Error(`Unknown spot token ${coin}`);
  }
  return `${token.name}:${token.tokenId}`;
}

export async function placeSpotDeskOrder(input: {
  agentPrivateKey: Hex;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  sizeCoin: number;
  oraclePx: number;
  limitPx?: number;
  feeTenths: number;
  cloidPrefix: string;
  builderAddress?: string | null;
  tif?: 'Gtc' | 'Ioc' | 'Alo';
}): Promise<PlaceDeskOrderResult> {
  const spotSymbol = await resolveSpotSymbol(input.symbol);
  const { assetId, szDecimals, pxDecimals } = await getSpotAssetIdAndMeta(spotSymbol);
  if (!Number.isFinite(input.sizeCoin) || input.sizeCoin <= 0) {
    throw new Error('Invalid size');
  }

  let refPx = Number.isFinite(input.oraclePx) && input.oraclePx > 0 ? input.oraclePx : 0;
  if (input.orderType === 'market' || !(refPx > 0)) {
    // Truly fresh mid: `allMids` is small (~18 KB) and lists spot pairs under
    // their universe name (`@107`, `PURR/USDC`). The spot meta blob is cached
    // for 60 s — fine for ids/decimals, too stale to price a market order.
    let fresh = 0;
    try {
      const mids = await hlInfo<Record<string, string>>({ type: 'allMids' });
      fresh = Number(mids?.[spotSymbol] ?? mids?.[spotSymbol.toUpperCase()] ?? 0);
    } catch {
      /* fall back to cached ctx */
    }
    if (!(Number.isFinite(fresh) && fresh > 0)) {
      try {
        const data = await getSpotMetaAndAssetCtxs();
        const ctx = (data[1] ?? []).find(
          (c) => String(c?.coin ?? '').toUpperCase() === spotSymbol.toUpperCase(),
        );
        fresh = Number(ctx?.midPx ?? ctx?.markPx ?? 0);
      } catch {
        /* keep oracle */
      }
    }
    if (Number.isFinite(fresh) && fresh > 0) refPx = fresh;
  }
  const sizingPx =
    input.orderType === 'limit' && Number.isFinite(input.limitPx ?? NaN) && (input.limitPx as number) > 0
      ? (input.limitPx as number)
      : refPx;
  if (!Number.isFinite(sizingPx) || sizingPx <= 0) {
    throw new Error('Invalid reference price');
  }

  const sizeUnitsRaw = input.sizeCoin;
  const minSizeUnits = Math.pow(10, -szDecimals);
  if (sizeUnitsRaw < minSizeUnits) {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * sizingPx).toFixed(2)})`);
  }
  let sizeUnits: string;
  try {
    sizeUnits = formatSize(sizeUnitsRaw, szDecimals);
  } catch {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * sizingPx).toFixed(2)})`);
  }
  const sizeUnitsParsed = parseFloat(sizeUnits);
  if (!sizeUnits || !Number.isFinite(sizeUnitsParsed) || sizeUnitsParsed <= 0) {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * sizingPx).toFixed(2)})`);
  }

  const slippageBps = input.side === 'sell' ? 300 : 200;
  const slippage = slippageBps / 10_000;
  const marketPx = input.side === 'buy' ? refPx * (1 + slippage) : refPx * (1 - slippage);
  const px = input.orderType === 'limit' ? input.limitPx : marketPx;
  if (!px || px <= 0) throw new Error('Missing price');
  const priceDecimals = Number.isFinite(pxDecimals ?? NaN) ? (pxDecimals as number) : szDecimals;
  const p = formatPrice(px, priceDecimals, 'spot');
  if (sizeUnitsParsed * Number(p) + 1e-9 < MIN_ORDER_USD) {
    throw new Error('Order must have minimum value of $10.');
  }

  const tif =
    input.orderType === 'limit'
      ? input.tif === 'Ioc' || input.tif === 'Alo'
        ? input.tif
        : 'Gtc'
      : 'FrontendMarket';
  const cloid = makeTenantCloid(input.cloidPrefix);
  const feeTenths = clampTenantFeeTenths(input.feeTenths);
  const exchange = createAgentExchangeClient(input.agentPrivateKey);

  const result = await exchange.order({
    orders: [
      {
        a: assetId,
        b: input.side === 'buy',
        p,
        s: sizeUnits,
        r: false,
        t: { limit: { tif } },
        c: cloid,
      },
    ],
    grouping: 'na',
    builder: { b: orderBuilderAddress(input.builderAddress), f: feeTenths },
  });

  const acceptErr = getPerpOrderAcceptanceError(result);
  if (acceptErr) throw new Error(acceptErr);
  return { raw: result, cloid, oid: extractHlOid(result) };
}

export async function transferUsdSpotPerp(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  amountUsd: string;
  toPerp: boolean;
}): Promise<void> {
  const amt = parseFloat(args.amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid transfer amount');
  await withUserSignedExchange(args.provider, args.userAddress, (ex) =>
    ex.usdClassTransfer({ amount: args.amountUsd, toPerp: args.toPerp }),
  );
}

export async function sendPerpUsdc(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  destination: Hex;
  amountUsd: string;
}): Promise<void> {
  const amt = parseFloat(args.amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid send amount');
  await withUserSignedExchange(args.provider, args.userAddress, (ex) =>
    ex.usdSend({ destination: args.destination, amount: args.amountUsd }),
  );
}

export async function sendSpotToken(args: {
  provider: Eip1193Provider;
  userAddress: Hex;
  destination: Hex;
  coin: string;
  amount: string;
}): Promise<void> {
  const amt = parseFloat(args.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid send amount');
  const token = await spotTokenWire(args.coin);
  await withUserSignedExchange(args.provider, args.userAddress, (ex) =>
    ex.spotSend({ destination: args.destination, token, amount: args.amount }),
  );
}
