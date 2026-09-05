/**
 * IOC limit bands for agent opens/closes (mid ± slip).
 *
 * Default stays 0.5% for majors — same as the historical global constant.
 * Thinner names get a wider band so Sunday/Asia alts don't no-match as often.
 * Hard-capped so we never silently pick off the book.
 *
 * Callers may still pass an explicit `slippage` to openPosition; adaptive
 * resolve is only the default. One widen-retry on IOC no-match is handled
 * in the adapter (never unbounded).
 */

import { estimateSweep, type BookSnapshot, type TakeSide } from './bookSnapshot.js';
import { liquidityTier } from './liquidityTier.js';

/** Historical worker default — BTC/ETH keep this. */
export const SLIPPAGE_MAJOR = 0.005;
/** Liquid non-majors (SOL, HYPE, …). */
export const SLIPPAGE_MID = 0.008;
/** Default for everything else (thin alts). */
export const SLIPPAGE_THIN = 0.015;
/** Absolute ceiling for adaptive + retry widen. */
export const SLIPPAGE_MAX = 0.03;
/**
 * Floor for the depth-aware band. The IOC price is computed off a book mid
 * that is ≤ a few seconds old; 15 bps absorbs that drift on majors without
 * handing the book a free 50 bps pick-off like the static tier did.
 */
export const SLIPPAGE_MIN_BOOK = 0.0015;
/** Safety margin added on top of the measured sweep (queue moves between snapshot and order). */
const BOOK_SLIP_BUFFER = 0.001;
const BOOK_SLIP_MULT = 1.5;

/**
 * Depth-aware IOC band: walk the taking side for `sizeUsd`, take the worst
 * level actually needed, pad it (×1.5 + 10 bps), clamp to [floor, max].
 * Returns null when the size does not fit inside SLIPPAGE_MAX — the caller
 * should fall back to the static tier (and the open gate will usually have
 * skipped such an order already).
 */
export function resolveBookSlippage(
  book: BookSnapshot,
  side: TakeSide,
  sizeUsd: number,
): number | null {
  const est = estimateSweep(book, side, sizeUsd, SLIPPAGE_MAX);
  if (!est.fullyFillable || est.worstSlipFrac == null) return null;
  const slip = est.worstSlipFrac * BOOK_SLIP_MULT + BOOK_SLIP_BUFFER;
  return Math.min(SLIPPAGE_MAX, Math.max(SLIPPAGE_MIN_BOOK, slip));
}

export function isIocNoMatch(detail: string): boolean {
  return /could not immediately match|immediately match against any resting/i.test(
    detail,
  );
}

function baseTierSlippage(symbol: string): number {
  const tier = liquidityTier(symbol);
  if (tier === 'major') return SLIPPAGE_MAJOR;
  if (tier === 'mid') return SLIPPAGE_MID;
  return SLIPPAGE_THIN;
}

/**
 * Larger notionals need a slightly wider band (whale / big probe vs thin book).
 * Does not replace proper slicing — just avoids obvious IOC no-matches.
 */
function sizeFloor(sizeUsd: number | undefined): number {
  if (sizeUsd == null || !(sizeUsd > 0)) return 0;
  if (sizeUsd >= 50_000) return SLIPPAGE_THIN;
  if (sizeUsd >= 10_000) return SLIPPAGE_MID;
  return 0;
}

export function resolveOpenSlippage(
  symbol: string,
  sizeUsd?: number,
): number {
  const slip = Math.max(baseTierSlippage(symbol), sizeFloor(sizeUsd));
  return Math.min(SLIPPAGE_MAX, slip);
}

/** Closes use the same tiers — filling an exit matters more than saving bps. */
export function resolveCloseSlippage(symbol: string): number {
  return resolveOpenSlippage(symbol);
}

/** One-step widen for IOC no-match retry (still ≤ SLIPPAGE_MAX). */
export function widenSlippage(current: number): number {
  const next = Math.max(current * 2, current + 0.01);
  return Math.min(SLIPPAGE_MAX, next);
}
