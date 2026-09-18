/**
 * Slim perp place path from `placeOrder` in
 * `frontend/src/lib/hyperliquid.ts` — builder + cloid, no JIT.
 * Supports market / limit plus stop & take (market + limit) triggers.
 *
 * Builder field: `{ b, f }` tenths of a bps (HL builder-codes).
 * Address comes from the tenant row; `f` is the tenant fee (0–100).
 *
 * Why no JIT `sendAsset` for HIP-3 (unlike mobile): web setup forces
 * `unifiedAccount` before any order (`ensureTradingReady`). Per HL margining
 * docs, unified / portfolio-margin accounts share margin across every USDC
 * dex, and isolated margin is drawn from the same spot pool — so an `xyz:*`
 * order does not need the dex pre-funded. Mobile's JIT is a Privy-signed
 * user action (extra popup + ~400ms settle) that only helps standard-mode
 * accounts. If HL ever rejects with insufficient margin here, the message is
 * surfaced as-is; the fix is a deposit, not a transfer.
 *
 * Latency: leverage update is cached 60s per (user, asset) and skipped for
 * reduce-only; the leverage commit and the fresh reference price run in
 * parallel (same as mobile). The order POST still waits for both.
 */
import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { getAssetIdAndMeta } from './assetId';
import { createAgentExchangeClient, hlInfo } from './clients';
import { getUserAbstractionMode } from './setup';
import { extractHlOid, getPerpOrderAcceptanceError, makeTenantCloid } from './cloid';
import { clampTenantFeeTenths, orderBuilderAddress, type Hex } from './constants';

export type DeskOrderType =
  | 'market'
  | 'limit'
  | 'stop_market'
  | 'stop_limit'
  | 'take_market'
  | 'take_limit';

export type PlaceDeskOrderInput = {
  agentPrivateKey: Hex;
  userAddress: Hex;
  symbol: string;
  side: 'long' | 'short';
  orderType: DeskOrderType;
  sizeCoin: number;
  oraclePx: number;
  limitPx?: number;
  /** Stop / take: price at which the trigger fires. */
  triggerPx?: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  feeTenths: number;
  cloidPrefix: string;
  builderAddress?: string | null;
  reduceOnly?: boolean;
  /** Plain limit only. Default Gtc. Ignored for triggers. */
  tif?: 'Gtc' | 'Ioc' | 'Alo';
  /** Attach as children with `normalTpsl` (plain market/limit only). */
  tpTriggerPx?: number;
  slTriggerPx?: number;
};

export type PlaceDeskOrderResult = {
  raw: unknown;
  cloid: string;
  oid: number | null;
};

/**
 * Fresh mid for the slippage-adjusted market price. `allMids` (~18 KB for the
 * whole core dex, HIP-3 keys already prefixed `xyz:AAPL`) instead of
 * `metaAndAssetCtxs` (~72 KB, every asset's full ctx) — same number, a
 * quarter of the bytes on the critical path of every market order / close.
 * Falls back to the ctx read if the mid is missing, then to the caller's px.
 */
async function freshReferencePx(symbol: string, fallback: number): Promise<number> {
  const dexName = symbol.includes(':') ? symbol.split(':')[0] : null;
  try {
    const payload: Record<string, unknown> = { type: 'allMids' };
    if (dexName) payload.dex = dexName;
    const mids = await hlInfo<Record<string, string>>(payload);
    const raw = mids?.[symbol] ?? mids?.[symbol.toUpperCase()];
    const mid = Number(raw);
    if (Number.isFinite(mid) && mid > 0) return mid;
  } catch {
    /* fall through to ctxs */
  }
  try {
    const payload: Record<string, unknown> = { type: 'metaAndAssetCtxs' };
    if (dexName) payload.dex = dexName;
    const data = await hlInfo<[ { universe?: Array<{ name?: string }> }, Array<Record<string, unknown>> ]>(payload);
    if (Array.isArray(data) && data.length >= 2) {
      const universe = data[0]?.universe ?? [];
      const assetIndex = universe.findIndex((u) => u?.name === symbol);
      if (assetIndex >= 0) {
        const ctx = data[1][assetIndex] ?? {};
        const ref = Number(ctx.midPx ?? ctx.markPx ?? ctx.oraclePx ?? 0);
        if (Number.isFinite(ref) && ref > 0) return ref;
      }
    }
  } catch {
    /* use fallback */
  }
  return fallback;
}

const MIN_ORDER_USD = 10;

/** Same TTL as mobile `LEVERAGE_CACHE_TTL_MS`. Only written after HL accepted. */
const LEVERAGE_CACHE_TTL_MS = 60_000;
const leverageCache = new Map<string, { leverage: number; isCross: boolean; timestamp: number }>();

/** Account mode changes only through setup; short cache avoids an /info hop per HIP-3 cross order. */
const MODE_CACHE_TTL_MS = 60_000;
const modeCache = new Map<string, { mode: string; timestamp: number }>();

async function cachedAbstractionMode(userAddress: Hex): Promise<string | null> {
  const key = userAddress.toLowerCase();
  const hit = modeCache.get(key);
  if (hit && Date.now() - hit.timestamp < MODE_CACHE_TTL_MS) return hit.mode;
  const mode = await getUserAbstractionMode(userAddress);
  if (mode) modeCache.set(key, { mode, timestamp: Date.now() });
  return mode;
}

/**
 * Commit leverage on HL unless we set the same (leverage, isCross) for this
 * user+asset within the TTL. Reduce-only orders never touch leverage — they
 * cannot open margin, and changing leverage under an open position is not
 * what the user asked for. Throws if HL rejects, so callers never place an
 * order on unconfirmed leverage.
 */
async function ensureLeverage(args: {
  exchange: ReturnType<typeof createAgentExchangeClient>;
  userAddress: Hex;
  assetId: number;
  leverage: number;
  isCross: boolean;
  reduceOnly: boolean;
}): Promise<void> {
  if (args.reduceOnly) return;
  const key = `${args.userAddress.toLowerCase()}:${args.assetId}`;
  const now = Date.now();
  const cached = leverageCache.get(key);
  if (
    cached &&
    cached.leverage === args.leverage &&
    cached.isCross === args.isCross &&
    now - cached.timestamp < LEVERAGE_CACHE_TTL_MS
  ) {
    return;
  }
  await args.exchange.updateLeverage({
    asset: args.assetId,
    isCross: args.isCross,
    leverage: args.leverage,
  });
  leverageCache.set(key, { leverage: args.leverage, isCross: args.isCross, timestamp: Date.now() });
}

/**
 * `formatSize` truncates to szDecimals. Exact $10 USDC → coin size often
 * rounds under HL's $10 min notional (esp. coarse HIP-3 lots). Bump by
 * one lot until size × wire price clears the floor.
 */
function formatSizeMeetingMinNotional(
  sizeCoin: number,
  px: number,
  szDecimals: number,
  reduceOnly: boolean,
): string {
  const lot = Math.pow(10, -szDecimals);
  let sizeUnits: string;
  try {
    sizeUnits = formatSize(sizeCoin, szDecimals);
  } catch {
    throw new Error(`Size too small for this market (min ${lot})`);
  }
  if (reduceOnly) return sizeUnits;

  let n = Number(sizeUnits);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Size too small for this market (min ${lot})`);
  }
  if (!Number.isFinite(px) || px <= 0) {
    throw new Error('Missing price');
  }

  let guard = 0;
  while (n * px + 1e-9 < MIN_ORDER_USD && guard++ < 10_000) {
    n = Math.round((n + lot) / lot) * lot;
    try {
      sizeUnits = formatSize(n, szDecimals);
    } catch {
      throw new Error('Order must have minimum value of $10.');
    }
    n = Number(sizeUnits);
  }
  if (n * px + 1e-9 < MIN_ORDER_USD) {
    throw new Error('Order must have minimum value of $10.');
  }
  return sizeUnits;
}

export async function placeDeskOrder(input: PlaceDeskOrderInput): Promise<PlaceDeskOrderResult> {
  const isHip3 = input.symbol.includes(':');
  const wantCross = input.marginMode === 'cross';
  // Account mode only gates HIP-3 cross. Core perps and isolated orders do
  // not need it, so skip the /info hop; when needed, overlap it with meta.
  const [{ assetId, szDecimals, maxLeverage, supportsCross }, mode] = await Promise.all([
    getAssetIdAndMeta(input.symbol),
    isHip3 && wantCross ? cachedAbstractionMode(input.userAddress) : Promise.resolve<string | null>(null),
  ]);
  if (!Number.isFinite(input.sizeCoin) || input.sizeCoin <= 0) {
    throw new Error('Invalid size');
  }
  if (!Number.isFinite(input.oraclePx) || input.oraclePx <= 0) {
    throw new Error('Invalid oracle price');
  }

  const sizeUsd = input.sizeCoin * input.oraclePx;
  if (sizeUsd + 1e-9 < MIN_ORDER_USD) {
    throw new Error('Order must have minimum value of $10.');
  }

  const minSizeUnits = Math.pow(10, -szDecimals);
  if (input.sizeCoin < minSizeUnits) {
    throw new Error(`Size too small for this market (min ${minSizeUnits})`);
  }

  const leverage = Math.max(1, Math.floor(input.leverage || 1));
  if (Number.isFinite(maxLeverage) && leverage > (maxLeverage as number)) {
    throw new Error(`Leverage too high for this market (max ${maxLeverage}x)`);
  }

  const isBuy = input.side === 'long';
  // UX order types map to HL `tpsl` the same way as mobile `placeOrder`:
  //   stop_* → sl (loss-direction: buy above mid, sell below)
  //   take_* → tp (profit-direction: buy below mid, sell above)
  const isStopOrder = input.orderType === 'stop_market' || input.orderType === 'stop_limit';
  const isTakeOrder = input.orderType === 'take_market' || input.orderType === 'take_limit';
  const isTriggerOrder = isStopOrder || isTakeOrder;
  const isLimitStyleTrigger = input.orderType === 'stop_limit' || input.orderType === 'take_limit';
  const isMarketStyleTrigger = input.orderType === 'stop_market' || input.orderType === 'take_market';
  if (isTriggerOrder) {
    if (!Number.isFinite(input.triggerPx) || (input.triggerPx as number) <= 0) {
      throw new Error('Missing trigger price');
    }
    if (isLimitStyleTrigger && (!input.limitPx || input.limitPx <= 0)) {
      throw new Error('Missing limit price');
    }
  }
  const isPooled = mode === 'unifiedAccount' || mode === 'portfolioMargin';
  // Same composite gate as `canUseCrossOnAsset` + `getPerpMarginSupport`
  // in `frontend/src/lib/hyperliquid.ts`. HIP-3 cross only in unified/PM.
  const hip3CrossOk = !isHip3 || isPooled;
  if (wantCross && (!supportsCross || !hip3CrossOk)) {
    throw new Error(
      !supportsCross
        ? 'This market is isolated-only.'
        : 'HIP-3 cross needs a unified account. Switch to Isolated or wait for setup.',
    );
  }
  const isCross = wantCross && supportsCross && hip3CrossOk;
  const exchange = createAgentExchangeClient(input.agentPrivateKey);

  // Leverage commit and fresh reference price are independent: one is an
  // exchange action, the other a read on /info. Run both; the order POST
  // below only happens after leverage is confirmed (Promise.all rejects on
  // leverage failure and we never sign the order). Price fetch swallows its
  // own errors and falls back to the caller's oracle px.
  const needsFreshPrice = isTriggerOrder || input.orderType === 'market';
  const [, referencePx] = await Promise.all([
    ensureLeverage({
      exchange,
      userAddress: input.userAddress,
      assetId,
      leverage,
      isCross,
      reduceOnly: !!input.reduceOnly,
    }),
    needsFreshPrice ? freshReferencePx(input.symbol, input.oraclePx) : Promise.resolve(input.oraclePx),
  ]);
  const defaultSlippageBps = isHip3 ? 100 : 50;
  const slippage = defaultSlippageBps / 10_000;
  const marketPx = isBuy ? referencePx * (1 + slippage) : referencePx * (1 - slippage);

  if (isTriggerOrder && Number.isFinite(referencePx) && referencePx > 0) {
    const triggerPx = input.triggerPx as number;
    if (isStopOrder) {
      if (input.side === 'long' && triggerPx <= referencePx) {
        throw new Error('Trigger must be above current price for stop buy orders');
      }
      if (input.side === 'short' && triggerPx >= referencePx) {
        throw new Error('Trigger must be below current price for stop sell orders');
      }
    } else if (isTakeOrder) {
      if (input.side === 'long' && triggerPx >= referencePx) {
        throw new Error('Trigger must be below current price for take buy orders');
      }
      if (input.side === 'short' && triggerPx <= referencePx) {
        throw new Error('Trigger must be above current price for take sell orders');
      }
    }
  }

  // Price selection matches mobile:
  //   limit / stop_limit / take_limit → explicit limit
  //   stop_market / take_market       → trigger (isMarket ignores wire px)
  //   market                          → slippage-adjusted reference
  const px =
    isLimitStyleTrigger || input.orderType === 'limit'
      ? input.limitPx
      : isTriggerOrder
        ? input.triggerPx
        : marketPx;
  if (!px || px <= 0) throw new Error('Missing price');

  const p = formatPrice(px, szDecimals, 'perp');
  // HL min-notional can be evaluated near mark/mid; use the lower of wire
  // vs reference so size×px stays ≥ $10 after truncate.
  const checkPx = Math.min(
    Number(p),
    referencePx > 0 ? referencePx : Number.POSITIVE_INFINITY,
    input.oraclePx > 0 ? input.oraclePx : Number.POSITIVE_INFINITY,
  );
  const sizeUnits = formatSizeMeetingMinNotional(
    input.sizeCoin,
    checkPx,
    szDecimals,
    !!input.reduceOnly,
  );

  type LimitTif = 'Gtc' | 'Ioc' | 'Alo' | 'FrontendMarket';
  const tif: LimitTif =
    input.orderType === 'limit'
      ? input.tif === 'Ioc' || input.tif === 'Alo'
        ? input.tif
        : 'Gtc'
      : isHip3
        ? 'FrontendMarket'
        : 'Ioc';
  const cloid = makeTenantCloid(input.cloidPrefix);
  const feeTenths = clampTenantFeeTenths(input.feeTenths);

  type WireOrder = {
    a: number;
    b: boolean;
    p: string;
    s: string;
    r: boolean;
    t:
      | { limit: { tif: LimitTif } }
      | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
    c?: string;
  };

  const parentT: WireOrder['t'] = isTriggerOrder
    ? {
        trigger: {
          isMarket: isMarketStyleTrigger,
          triggerPx: formatPrice(input.triggerPx as number, szDecimals, 'perp'),
          tpsl: isStopOrder ? 'sl' : 'tp',
        },
      }
    : { limit: { tif } };

  const orders: WireOrder[] = [
    {
      a: assetId,
      b: isBuy,
      p,
      s: sizeUnits,
      r: !!input.reduceOnly,
      t: parentT,
      c: cloid,
    },
  ];

  // Nested TP/SL only on plain market/limit. A stop/take order IS the trigger;
  // HL rejects grouping another trigger onto it.
  const closeIsBuy = !isBuy;
  const tpPx = !isTriggerOrder ? input.tpTriggerPx : undefined;
  const slPx = !isTriggerOrder ? input.slTriggerPx : undefined;
  if (tpPx != null && Number.isFinite(tpPx) && tpPx > 0) {
    const childTriggerPx = formatPrice(tpPx, szDecimals, 'perp');
    orders.push({
      a: assetId,
      b: closeIsBuy,
      p: childTriggerPx,
      s: sizeUnits,
      r: true,
      t: { trigger: { isMarket: true, triggerPx: childTriggerPx, tpsl: 'tp' } },
    });
  }
  if (slPx != null && Number.isFinite(slPx) && slPx > 0) {
    const childTriggerPx = formatPrice(slPx, szDecimals, 'perp');
    orders.push({
      a: assetId,
      b: closeIsBuy,
      p: childTriggerPx,
      s: sizeUnits,
      r: true,
      t: { trigger: { isMarket: true, triggerPx: childTriggerPx, tpsl: 'sl' } },
    });
  }

  const result = await exchange.order({
    orders: orders as Parameters<typeof exchange.order>[0]['orders'],
    grouping: orders.length > 1 ? 'normalTpsl' : 'na',
    builder: { b: orderBuilderAddress(input.builderAddress), f: feeTenths },
  });

  const acceptErr = getPerpOrderAcceptanceError(result);
  if (acceptErr) throw new Error(acceptErr);

  return { raw: result, cloid, oid: extractHlOid(result) };
}

/**
 * Position-linked TP and/or SL in **one** exchange action — `s='0'`,
 * `grouping: positionTpsl`, both triggers as sibling orders. Half the round
 * trips of placing them one after the other, and HL treats them as one
 * TP/SL pair. Prefer this over two `placeReduceOnlyTpslTrigger` calls.
 */
export async function placePositionTpsl(args: {
  agentPrivateKey: Hex;
  symbol: string;
  entrySide: 'long' | 'short';
  tpTriggerPx?: number | null;
  slTriggerPx?: number | null;
  feeTenths: number;
  builderAddress?: string | null;
}): Promise<unknown> {
  const legs: Array<{ tpsl: 'tp' | 'sl'; px: number }> = [];
  if (args.tpTriggerPx != null && Number.isFinite(args.tpTriggerPx) && args.tpTriggerPx > 0) {
    legs.push({ tpsl: 'tp', px: args.tpTriggerPx });
  }
  if (args.slTriggerPx != null && Number.isFinite(args.slTriggerPx) && args.slTriggerPx > 0) {
    legs.push({ tpsl: 'sl', px: args.slTriggerPx });
  }
  if (!legs.length) throw new Error('Set a take profit or a stop loss');
  const { assetId, szDecimals } = await getAssetIdAndMeta(args.symbol);
  const isBuy = args.entrySide === 'short';
  const exchange = createAgentExchangeClient(args.agentPrivateKey);
  const feeTenths = clampTenantFeeTenths(args.feeTenths);
  const result = await exchange.order({
    orders: legs.map((leg) => {
      const triggerPx = formatPrice(leg.px, szDecimals, 'perp');
      return {
        a: assetId,
        b: isBuy,
        p: triggerPx,
        s: '0',
        r: true,
        t: { trigger: { isMarket: true, triggerPx, tpsl: leg.tpsl } },
      };
    }),
    grouping: 'positionTpsl',
    builder: { b: orderBuilderAddress(args.builderAddress), f: feeTenths },
  });
  const acceptErr = getPerpOrderAcceptanceError(result);
  if (acceptErr) throw new Error(acceptErr);
  return result;
}

/**
 * Position-linked TP/SL — same contract as mobile
 * `placeReduceOnlyTpslTrigger` (`s='0'` + `grouping: positionTpsl`).
 * Single leg; use {@link placePositionTpsl} when setting both.
 */
export async function placeReduceOnlyTpslTrigger(args: {
  agentPrivateKey: Hex;
  symbol: string;
  entrySide: 'long' | 'short';
  oraclePx: number;
  triggerPx: number;
  tpsl: 'tp' | 'sl';
  feeTenths: number;
  builderAddress?: string | null;
}): Promise<unknown> {
  const { assetId, szDecimals } = await getAssetIdAndMeta(args.symbol);
  if (!Number.isFinite(args.oraclePx) || args.oraclePx <= 0) throw new Error('Invalid oracle price');
  if (!Number.isFinite(args.triggerPx) || args.triggerPx <= 0) throw new Error('Invalid trigger price');

  const isBuy = args.entrySide === 'short';
  const triggerPx = formatPrice(args.triggerPx, szDecimals, 'perp');
  const p = triggerPx;
  const exchange = createAgentExchangeClient(args.agentPrivateKey);
  const feeTenths = clampTenantFeeTenths(args.feeTenths);

  const result = await exchange.order({
    orders: [
      {
        a: assetId,
        b: isBuy,
        p,
        s: '0',
        r: true,
        t: { trigger: { isMarket: true, triggerPx, tpsl: args.tpsl } },
      },
    ],
    grouping: 'positionTpsl',
    builder: { b: orderBuilderAddress(args.builderAddress), f: feeTenths },
  });

  const acceptErr = getPerpOrderAcceptanceError(result);
  if (acceptErr) throw new Error(acceptErr);
  return result;
}

/** Cancel a resting open order by oid — same as mobile `cancelOpenOrder`. */
export async function cancelDeskOrder(args: {
  agentPrivateKey: Hex;
  symbol: string;
  oid: number;
}): Promise<unknown> {
  if (!Number.isFinite(args.oid) || args.oid <= 0) {
    throw new Error('Invalid order id');
  }
  const { assetId } = await getAssetIdAndMeta(args.symbol);
  const exchange = createAgentExchangeClient(args.agentPrivateKey);
  return exchange.cancel({ cancels: [{ a: assetId, o: args.oid }] });
}

/**
 * Cancel several resting orders in **one** exchange action (HL `cancel`
 * takes an array). Meta lookups run in parallel and are cached, so this is
 * one signature + one POST regardless of how many orders. No-op on empty.
 */
export async function cancelDeskOrders(args: {
  agentPrivateKey: Hex;
  orders: Array<{ symbol: string; oid: number }>;
}): Promise<unknown | null> {
  const wanted = args.orders.filter((o) => Number.isFinite(o.oid) && o.oid > 0);
  if (!wanted.length) return null;
  const metas = await Promise.all(wanted.map((o) => getAssetIdAndMeta(o.symbol)));
  const exchange = createAgentExchangeClient(args.agentPrivateKey);
  return exchange.cancel({
    cancels: wanted.map((o, i) => ({ a: metas[i].assetId, o: o.oid })),
  });
}

/**
 * Edit a resting open order — same as mobile `modifyOpenOrder`.
 * Limits go through `exchange.modify` with Alo (HL rest-only). Triggers
 * (position TP/SL) are cancel + re-place with `s='0'` so we do not demote them.
 */
export async function modifyDeskOrder(args: {
  agentPrivateKey: Hex;
  symbol: string;
  oid: number;
  side: 'buy' | 'sell' | 'B' | 'A';
  sizeUnits: string | number;
  limitPx: number;
  reduceOnly?: boolean;
  cloid?: string | null;
  isTrigger?: boolean;
  tpsl?: 'tp' | 'sl' | null;
  feeTenths: number;
  builderAddress?: string | null;
}): Promise<unknown> {
  if (args.isTrigger) {
    const tpsl = args.tpsl === 'tp' || args.tpsl === 'sl' ? args.tpsl : null;
    if (!tpsl) {
      throw new Error('Cannot edit this trigger (missing TP/SL type). Cancel it and place a new TP/SL instead.');
    }
    if (!Number.isFinite(args.limitPx) || args.limitPx <= 0) {
      throw new Error('Invalid trigger price');
    }
    const sideRaw = String(args.side).toLowerCase();
    const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
    const entrySide: 'long' | 'short' = isBuy ? 'short' : 'long';

    await cancelDeskOrder({
      agentPrivateKey: args.agentPrivateKey,
      symbol: args.symbol,
      oid: args.oid,
    });

    return placeReduceOnlyTpslTrigger({
      agentPrivateKey: args.agentPrivateKey,
      symbol: args.symbol,
      entrySide,
      oraclePx: args.limitPx,
      triggerPx: args.limitPx,
      tpsl,
      feeTenths: args.feeTenths,
      builderAddress: args.builderAddress,
    });
  }

  const { assetId, szDecimals } = await getAssetIdAndMeta(args.symbol);
  const sizeUnitsRaw = Math.abs(parseFloat(String(args.sizeUnits)));
  if (!Number.isFinite(sizeUnitsRaw) || sizeUnitsRaw <= 0) {
    throw new Error('Invalid size');
  }
  const minSizeUnits = Math.pow(10, -szDecimals);
  if (sizeUnitsRaw < minSizeUnits) {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * args.limitPx).toFixed(2)})`);
  }
  if (!Number.isFinite(args.limitPx) || args.limitPx <= 0) {
    throw new Error('Invalid limit price');
  }
  if (!args.reduceOnly && sizeUnitsRaw * args.limitPx + 1e-9 < MIN_ORDER_USD) {
    throw new Error('Order must have minimum value of $10.');
  }

  let s: string;
  try {
    s = formatSize(sizeUnitsRaw, szDecimals);
  } catch {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * args.limitPx).toFixed(2)})`);
  }
  const p = formatPrice(args.limitPx, szDecimals, 'perp');
  const sideRaw = String(args.side).toLowerCase();
  const isBuy = sideRaw === 'b' || sideRaw === 'buy' || sideRaw === 'long';
  const exchange = createAgentExchangeClient(args.agentPrivateKey);

  const result = await exchange.modify({
    oid: args.oid,
    order: {
      a: assetId,
      b: isBuy,
      p,
      s,
      r: !!args.reduceOnly,
      t: { limit: { tif: 'Alo' } },
      c: args.cloid ?? undefined,
    },
  });
  return result;
}

/**
 * Market close — same path as `marketClosePosition` in
 * `frontend/src/lib/hyperliquid.ts`: opposite side, `r: true`,
 * FrontendMarket, 4.5% slippage. Adds tenant cloid + builder so
 * attribution can snapshot notional / est fee.
 */
export async function marketCloseDeskPosition(args: {
  agentPrivateKey: Hex;
  symbol: string;
  szi: number;
  oraclePx?: number;
  feeTenths: number;
  cloidPrefix: string;
  builderAddress?: string | null;
}): Promise<PlaceDeskOrderResult & { side: 'buy' | 'sell'; notionalUsd: number; referencePx: number }> {
  if (!Number.isFinite(args.szi) || args.szi === 0) {
    throw new Error('No position');
  }
  // Meta (cached after first use) and the fresh mid are independent — same
  // parallelism as `placeDeskOrder` so a close is one network hop, not two.
  const [{ assetId, szDecimals }, referencePx] = await Promise.all([
    getAssetIdAndMeta(args.symbol),
    freshReferencePx(args.symbol, args.oraclePx ?? 0),
  ]);
  const isBuy = args.szi < 0;
  const sizeCoin = Math.abs(args.szi);
  if (!referencePx || referencePx <= 0) {
    throw new Error(`Invalid reference price for ${args.symbol}`);
  }

  const minSizeUnits = Math.pow(10, -szDecimals);
  if (sizeCoin < minSizeUnits) {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * referencePx).toFixed(2)})`);
  }
  let sizeUnits: string;
  try {
    sizeUnits = formatSize(sizeCoin, szDecimals);
  } catch {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * referencePx).toFixed(2)})`);
  }
  if (!sizeUnits || sizeUnits === '0' || Number(sizeUnits) <= 0) {
    throw new Error(`Size too small for this market (min ≈ $${(minSizeUnits * referencePx).toFixed(2)})`);
  }

  const slippage = 450 / 10_000;
  const pxRaw = isBuy ? referencePx * (1 + slippage) : referencePx * (1 - slippage);
  const p = formatPrice(pxRaw, szDecimals, 'perp');
  const cloid = makeTenantCloid(args.cloidPrefix);
  const feeTenths = clampTenantFeeTenths(args.feeTenths);
  const exchange = createAgentExchangeClient(args.agentPrivateKey);

  const result = await exchange.order({
    orders: [
      {
        a: assetId,
        b: isBuy,
        p,
        s: sizeUnits,
        r: true,
        t: { limit: { tif: 'FrontendMarket' } },
        c: cloid,
      },
    ],
    grouping: 'na',
    builder: { b: orderBuilderAddress(args.builderAddress), f: feeTenths },
  });

  const acceptErr = getPerpOrderAcceptanceError(result);
  if (acceptErr) throw new Error(acceptErr);

  return {
    raw: result,
    cloid,
    oid: extractHlOid(result),
    side: isBuy ? 'buy' : 'sell',
    notionalUsd: sizeCoin * referencePx,
    referencePx,
  };
}
