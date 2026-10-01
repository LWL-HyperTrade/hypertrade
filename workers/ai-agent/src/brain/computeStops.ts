/**
 * Stop-Loss and Take-Profit Calculator
 *
 * Uses session range (H-L) with smart fallbacks.
 * Floors / caps / hint multipliers are per asset class — crypto stayed
 * BTC/ETH-calibrated; equities, FX, commodities, and indices use their
 * own typical intraday % ranges so a forced rescue stop isn't a blind
 * 2% BTC default on every book.
 */

import type { Side } from './computeScalperFlags.js';
import type { AssetClass } from './assetClass.js';

export interface FuturesBar {
  timestamp: number;
  high_price?: number;
  low_price?: number;
  close_price?: number;
  dollar_volume?: number;
  coin_volume?: number;
}

export interface StopPlan {
  // absolute prices
  stopPrice: number;
  tp1: number;
  tp2: number;
  tp3: number;

  // risk stats
  R: number; // stop distance in price terms
  sessionHigh: number;
  sessionLow: number;
  sessionRange: number;
  vwapProxy?: number;

  // trailing logic (expressed in R)
  trail: {
    toBreakevenAtR: number; // move stop to entry at +1R
    trailDistanceR: number; // maintain trailing stop at this distance in R once > toBreakevenAtR
  };
  notes: string[];
  volatilityState?: 'low' | 'normal' | 'high';
}

/** Class-specific stop geometry (fractions of entry unless noted). */
export interface StopGeometry {
  /** Hard rescue floor — never leave a stop tighter than this. */
  minStopPct: number;
  /** Soft preferred distance when session math is thin. */
  preferredStopPct: number;
  /** Hard cap — don't place stops wider than this. */
  maxStopPct: number;
  hintTight: number;
  hintMedium: number;
  hintLoose: number;
  /** Session range % of price → low / high vol regime. */
  volLowPct: number;
  volHighPct: number;
}

export function stopGeometryFor(assetClass: AssetClass): StopGeometry {
  switch (assetClass) {
    case 'equity':
    case 'index':
      // Equities/ETFs: daily moves often 1–3%; 2% floor is noise-safe.
      return {
        minStopPct: 0.02,
        preferredStopPct: 0.025,
        maxStopPct: 0.06,
        hintTight: 0.30,
        hintMedium: 0.40,
        hintLoose: 0.55,
        volLowPct: 0.8,
        volHighPct: 3.0,
      };
    case 'commodity':
      return {
        minStopPct: 0.015,
        preferredStopPct: 0.025,
        maxStopPct: 0.05,
        hintTight: 0.28,
        hintMedium: 0.38,
        hintLoose: 0.50,
        volLowPct: 1.0,
        volHighPct: 4.0,
      };
    case 'forex':
      // FX daily ranges are often well under 1% — a 2% stop is a week of risk.
      return {
        minStopPct: 0.004,
        preferredStopPct: 0.008,
        maxStopPct: 0.02,
        hintTight: 0.30,
        hintMedium: 0.40,
        hintLoose: 0.55,
        volLowPct: 0.3,
        volHighPct: 1.2,
      };
    default:
      // Crypto (BTC/ETH-tuned intraday)
      return {
        minStopPct: 0.02,
        preferredStopPct: 0.035,
        maxStopPct: 0.08,
        hintTight: 0.25,
        hintMedium: 0.35,
        hintLoose: 0.50,
        volLowPct: 1.5,
        volHighPct: 4.5,
      };
  }
}

/** Helpers */
const last = <T>(a: T[]) => (a.length ? a[a.length - 1] : undefined);
const takeLast = <T>(a: T[], n: number) => a.slice(Math.max(0, a.length - n));
const median = (arr: number[]) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Get UTC midnight (start of day) for a timestamp */
function utcMidnight(ts: number) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Compute intraday session stats (H, L, range, VWAP proxy) */
export function computeSessionStats(bars: FuturesBar[]) {
  if (!bars.length) return null;
  const lastBar = last(bars)!;
  const start = utcMidnight(lastBar.timestamp);
  const session = bars.filter(b => b.timestamp >= start);

  const highs = session.map(b => b.high_price ?? NaN).filter(Number.isFinite) as number[];
  const lows = session.map(b => b.low_price ?? NaN).filter(Number.isFinite) as number[];

  // If no session data, use all bars
  if (highs.length === 0 || lows.length === 0) {
    const allHighs = bars.map(b => b.high_price ?? NaN).filter(Number.isFinite) as number[];
    const allLows = bars.map(b => b.low_price ?? NaN).filter(Number.isFinite) as number[];
    const sessionHigh = allHighs.length ? Math.max(...allHighs) : NaN;
    const sessionLow = allLows.length ? Math.min(...allLows) : NaN;
    const sessionRange =
      Number.isFinite(sessionHigh) && Number.isFinite(sessionLow) ? sessionHigh - sessionLow : NaN;

    const dv = bars.reduce((s, b) => s + (b.dollar_volume ?? 0), 0);
    const cv = bars.reduce((s, b) => s + (b.coin_volume ?? 0), 0);
    const vwapProxy = (cv > 0 ? dv / cv : undefined);
    const barRanges = takeLast(bars, 60).map(b => (b.high_price ?? 0) - (b.low_price ?? 0));
    const medBarRange = median(barRanges);

    return { session: bars, sessionHigh, sessionLow, sessionRange, vwapProxy, medBarRange };
  }

  const sessionHigh = Math.max(...highs);
  const sessionLow = Math.min(...lows);
  const sessionRange = sessionHigh - sessionLow;

  const dv = session.reduce((s, b) => s + (b.dollar_volume ?? 0), 0);
  const cv = session.reduce((s, b) => s + (b.coin_volume ?? 0), 0);
  const vwapProxy = (cv > 0 ? dv / cv : undefined);

  // median bar range for fallback & sanity caps
  const barRanges = takeLast(bars, 60).map(b => (b.high_price ?? 0) - (b.low_price ?? 0));
  const medBarRange = median(barRanges);

  return { session, sessionHigh, sessionLow, sessionRange, vwapProxy, medBarRange };
}

/**
 * Calculate liquidation price for a position
 */
function calculateLiquidationPrice(
  entryPrice: number,
  side: 'long' | 'short',
  leverage: number = 10
): number {
  // Liquidation price formula:
  // For LONG: liquidation = entry * (1 - 1/leverage)
  // For SHORT: liquidation = entry * (1 + 1/leverage)
  const liquidationFactor = 1 / leverage;

  if (side === 'long') {
    return entryPrice * (1 - liquidationFactor);
  } else {
    return entryPrice * (1 + liquidationFactor);
  }
}

/**
 * Safety check: ensure stop price never exceeds liquidation price
 */
function validateStopAgainstLiquidation(
  stopPrice: number,
  entryPrice: number,
  side: 'long' | 'short',
  leverage: number = 10
): number {
  const liquidationPrice = calculateLiquidationPrice(entryPrice, side, leverage);

  if (side === 'long') {
    // For LONG: stop must be ABOVE liquidation price
    if (stopPrice <= liquidationPrice) {
      console.warn(`⚠️ Stop price ${stopPrice.toFixed(2)} too close to liquidation ${liquidationPrice.toFixed(2)} for LONG. Adjusting...`);
      return liquidationPrice * 1.01; // 1% buffer above liquidation
    }
  } else {
    // For SHORT: stop must be BELOW liquidation price
    if (stopPrice >= liquidationPrice) {
      console.warn(`⚠️ Stop price ${stopPrice.toFixed(2)} too close to liquidation ${liquidationPrice.toFixed(2)} for SHORT. Adjusting...`);
      return liquidationPrice * 0.99; // 1% buffer below liquidation
    }
  }

  return stopPrice;
}

/**
 * Plan stops & targets from day range (H−L) with smart fallbacks.
 * - hint: 'tight' (scalp), 'medium' (default), 'loose' (messy vols / swing)
 * - assetClass: drives min/preferred/max % and session-range multipliers
 */
export function planStops(
  entryPrice: number,
  side: Side,
  bars: FuturesBar[],
  hint: 'tight' | 'medium' | 'loose' = 'medium',
  leverage: number = 10,
  assetClass: AssetClass = 'crypto',
): StopPlan {
  if (!bars.length || !Number.isFinite(entryPrice)) {
    console.error(`❌ planStops: Invalid inputs:`, {
      entryPrice,
      side,
      barsLength: bars.length,
      bars: bars.slice(0, 3) // Show first 3 bars for debugging
    });
    throw new Error('planStops: missing bars or entryPrice');
  }
  const stats = computeSessionStats(bars);
  if (!stats) throw new Error('planStops: session stats unavailable');

  const geo = stopGeometryFor(assetClass);
  const { sessionHigh, sessionLow, sessionRange, vwapProxy, medBarRange } = stats;
  const notes: string[] = [];
  notes.push(`stop geometry: ${assetClass} (min ${(geo.minStopPct * 100).toFixed(1)}% / preferred ${(geo.preferredStopPct * 100).toFixed(1)}% / max ${(geo.maxStopPct * 100).toFixed(1)}%)`);

  const rangePct = entryPrice > 0 ? (sessionRange / entryPrice) * 100 : NaN;
  let volatilityState: 'low' | 'normal' | 'high' = 'normal';
  if (Number.isFinite(rangePct)) {
    if (rangePct <= geo.volLowPct) {
      volatilityState = 'low';
    } else if (rangePct >= geo.volHighPct) {
      volatilityState = 'high';
    }
  }
  if (volatilityState !== 'normal') {
    notes.push(`volatility regime: ${volatilityState} (range ${rangePct?.toFixed(2) ?? 'N/A'}%)`);
  }

  // Dynamic base range: prefer sessionRange; if too tiny, blend with median bar range.
  const hasSession =
    Number.isFinite(sessionHigh) &&
    Number.isFinite(sessionLow) &&
    Number.isFinite(sessionRange) &&
    sessionRange > 0;
  const baseRange = hasSession
    ? Math.max(sessionRange, 1.5 * (Number.isFinite(medBarRange) ? medBarRange : 0))
    : 0;
  if (hasSession && sessionRange < (medBarRange || 0)) notes.push('fallback: sessionRange < median bar range');

  const m = hint === 'tight' ? geo.hintTight : hint === 'loose' ? geo.hintLoose : geo.hintMedium;
  let R = m * baseRange;
  const volatilityScalar = volatilityState === 'low' ? 1.15 : volatilityState === 'high' ? 0.85 : 1;
  if (volatilityScalar !== 1) {
    notes.push(`R adjusted by volatility scalar ${volatilityScalar.toFixed(2)}`);
  }
  R *= volatilityScalar;

  // First hour stop guard (00:05 UTC) - session range is tiny
  const isFirstHourUTC = new Date().getUTCHours() === 0;
  const minRFromBars = (isFirstHourUTC ? 0.30 : 0.20) * (medBarRange || 0);
  const preferredR = entryPrice * geo.preferredStopPct;
  const maxRFromPct = entryPrice * geo.maxStopPct;
  const maxRFromSession = hasSession ? 0.80 * Math.max(baseRange, sessionRange) : maxRFromPct;

  // Soft floor at preferred %, then session/bar clamps, then hard max %.
  R = Math.max(R, preferredR);
  R = clamp(R, minRFromBars, Math.max(1e-8, maxRFromSession));
  R = Math.min(R, maxRFromPct);

  // Price arithmetic
  const dir = side === 'long' ? +1 : -1;

  // Trailing scheme:
  // - move to breakeven at +1R
  // - adjust trailing distance with volatility regime
  let trailDistanceR = hint === 'tight' ? 0.6 : hint === 'loose' ? 1.0 : 0.8;
  let toBreakevenAtR = 1.0;
  if (volatilityState === 'low') {
    trailDistanceR = Math.min(1.1, trailDistanceR + 0.15);
    toBreakevenAtR = 1.2;
    notes.push('trail loosened for low-vol chop');
  } else if (volatilityState === 'high') {
    trailDistanceR = Math.max(0.5, trailDistanceR - 0.15);
    toBreakevenAtR = 0.8;
    notes.push('trail tightened for high-vol regime');
  }

  const rawStop = entryPrice - dir * R;
  const maxDistLong = entryPrice - maxRFromPct;  // farthest long stop allowed
  const maxDistShort = entryPrice + maxRFromPct;

  // enforce session bounds, then hard max distance
  const boundLong = hasSession ? Math.max(rawStop, sessionLow) : rawStop;
  const boundShort = hasSession ? Math.min(rawStop, sessionHigh) : rawStop;

  let finalStop: number;
  if (side === 'long') {
    // stop below entry, not below session low, not wider than maxStopPct
    finalStop = Math.max(boundLong, maxDistLong);
    finalStop = Math.min(finalStop, entryPrice - 1e-6);
    if (hasSession && finalStop <= sessionLow) finalStop = boundLong;
  } else {
    finalStop = hasSession ? Math.min(boundShort, sessionHigh) : boundShort;
    finalStop = Math.min(finalStop, maxDistShort);
    finalStop = Math.max(finalStop, entryPrice + 1e-6);
    if (hasSession && finalStop > sessionHigh) finalStop = sessionHigh - 1e-6;
  }

  // CRITICAL SAFETY CHECK: Ensure stop never exceeds liquidation price
  finalStop = validateStopAgainstLiquidation(finalStop, entryPrice, side, leverage);

  // Recompute R and TPs after any stop adjustments to maintain symmetry
  let finalR = Math.abs(entryPrice - finalStop);
  const finalStopPct = entryPrice > 0 ? (finalR / entryPrice) * 100 : 0;
  const minStopPctPoints = geo.minStopPct * 100;

  // Hard rescue: if session bounding crushed the stop below class min, widen.
  if (finalStopPct < minStopPctPoints) {
    console.warn(
      `⚠️ Stop too tight (${finalStopPct.toFixed(2)}%) — using minimum ${(minStopPctPoints).toFixed(1)}% stop [${assetClass}]`,
    );
    finalR = entryPrice * geo.minStopPct;
    finalStop = side === 'long' ? entryPrice - finalR : entryPrice + finalR;
    notes.push(
      `stop widened to ${(minStopPctPoints).toFixed(1)}% ${assetClass} minimum due to tight session cap: ${finalStop.toFixed(2)}`,
    );
  }

  const tp1 = entryPrice + dir * finalR;
  const tp2 = entryPrice + dir * 2 * finalR;
  const tp3 = entryPrice + dir * 3 * finalR;

  if (finalStop !== rawStop) {
    const tightened =
      (side === 'long' && finalStop > rawStop) ||
      (side === 'short' && finalStop < rawStop);
    if (tightened) {
      notes.push(`stop tightened to respect ${(geo.maxStopPct * 100).toFixed(1)}% max: ${finalStop.toFixed(2)}`);
    } else {
      notes.push(`stop capped at session extreme: ${finalStop.toFixed(2)}`);
    }
  }

  // Safety check: ensure all values are finite
  if (!Number.isFinite(finalStop) || !Number.isFinite(tp1) || !Number.isFinite(R)) {
    console.error(`❌ planStops: Invalid values detected:`, {
      finalStop,
      tp1,
      R,
      entryPrice,
      side,
      sessionHigh,
      sessionLow,
      sessionRange,
      assetClass,
    });

    const fallbackR = entryPrice * geo.preferredStopPct;
    const fallbackStop = side === 'long' ? entryPrice - fallbackR : entryPrice + fallbackR;
    const fallbackTp1 = side === 'long' ? entryPrice + fallbackR : entryPrice - fallbackR;

    return {
      stopPrice: fallbackStop,
      tp1: fallbackTp1,
      tp2: side === 'long' ? entryPrice + 2 * fallbackR : entryPrice - 2 * fallbackR,
      tp3: side === 'long' ? entryPrice + 3 * fallbackR : entryPrice - 3 * fallbackR,
      R: fallbackR,
      sessionHigh, sessionLow, sessionRange,
      vwapProxy,
      trail: { toBreakevenAtR, trailDistanceR },
      notes: [...notes, `FALLBACK: Used ${(geo.preferredStopPct * 100).toFixed(1)}% ${assetClass} preferred stop due to invalid calculations`],
      volatilityState,
    };
  }

  return {
    stopPrice: finalStop,
    tp1, tp2, tp3,
    R: finalR, // Use recomputed R to match actual stop distance
    sessionHigh, sessionLow, sessionRange,
    vwapProxy,
    trail: { toBreakevenAtR, trailDistanceR },
    notes,
    volatilityState,
  };
}

/**
 * Update trailing stop given latest price and prior plan.
 * - When unrealized ≥ toBreakevenAtR, stop -> entry.
 * - Then maintain trailing stop at trailDistanceR behind last extreme.
 */
export function updateTrailingStop(
  plan: StopPlan,
  side: Side,
  entryPrice: number,
  lastPrice: number,
  lastExtremePrice: number, // highest since entry (long) or lowest since entry (short)
  currentStop: number
): number {
  const dir = side === 'long' ? +1 : -1;
  const upnl = (lastPrice - entryPrice) * dir;
  let newStop = currentStop;

  // move to breakeven at +1R
  if (upnl >= plan.trail.toBreakevenAtR * plan.R) {
    newStop = Math.max(newStop, entryPrice); // never loosen
  }

  // trail by trailDistanceR after BE reached
  if (newStop >= entryPrice) {
    const trail = lastExtremePrice - dir * (plan.trail.trailDistanceR * plan.R);
    newStop = side === 'long' ? Math.max(newStop, trail) : Math.min(newStop, trail);
  }

  return newStop;
}
