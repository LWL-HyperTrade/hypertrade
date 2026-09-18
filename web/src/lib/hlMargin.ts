export type MarginTier = {
  /** Notional position lower bound (USDC) */
  lowerBoundUsd: number;
  /** Tier max leverage (integer) */
  maxLeverage: number;
};

export type MaintenanceScheduleTier = MarginTier & {
  /** maintenance_margin_rate for this tier */
  mmr: number;
  /** maintenance_deduction for this tier */
  deductionUsd: number;
};

export function buildMaintenanceSchedule(tiers: MarginTier[]): MaintenanceScheduleTier[] {
  const sorted = [...tiers].sort((a, b) => a.lowerBoundUsd - b.lowerBoundUsd);
  const out: MaintenanceScheduleTier[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const mmr = 1 / (2 * Math.max(1, t.maxLeverage)); // per HL docs: maintenance_margin_rate = IMR(maxLev)/2 = (1/maxLev)/2
    if (i === 0) {
      out.push({ ...t, mmr, deductionUsd: 0 });
      continue;
    }
    const prev = out[i - 1];
    // maintenance_deduction(tier=n) = maintenance_deduction(n-1) + lowerBound(n) * (mmr(n) - mmr(n-1))
    const deductionUsd = prev.deductionUsd + t.lowerBoundUsd * (mmr - prev.mmr);
    out.push({ ...t, mmr, deductionUsd });
  }

  return out;
}

export function maintenanceMarginRequired(notionalUsd: number, schedule: MaintenanceScheduleTier[]): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || schedule.length === 0) return 0;

  // choose the last tier whose lowerBoundUsd <= notional
  let tier = schedule[0];
  for (let i = 1; i < schedule.length; i++) {
    if (notionalUsd >= schedule[i].lowerBoundUsd) tier = schedule[i];
  }

  // maintenance_margin = notional * mmr - deduction
  return Math.max(0, notionalUsd * tier.mmr - tier.deductionUsd);
}

export function estimateLiqPriceIsolated(args: {
  entryPx: number;
  side: 'long' | 'short';
  sizeUnits: number;
  leverage: number;
  schedule: MaintenanceScheduleTier[];
}): number | null {
  const entryPx = args.entryPx;
  const size = args.sizeUnits;
  const lev = Math.max(1, Math.floor(args.leverage));
  if (!Number.isFinite(entryPx) || entryPx <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!Number.isFinite(lev) || lev <= 0) return null;
  if (!args.schedule?.length) return null;

  // Initial margin per HL docs: position_size * mark_price / leverage
  const initialMarginUsd = (size * entryPx) / lev;

  // Equity at price P:
  // long: margin + (P-entry)*size
  // short: margin + (entry-P)*size
  const equity = (P: number) =>
    args.side === 'long'
      ? initialMarginUsd + (P - entryPx) * size
      : initialMarginUsd + (entryPx - P) * size;

  const f = (P: number) => {
    const notional = P * size;
    return equity(P) - maintenanceMarginRequired(notional, args.schedule);
  };

  // Bisection bounds
  let lo: number;
  let hi: number;
  if (args.side === 'long') {
    hi = entryPx;
    lo = entryPx * 0.0001;
  } else {
    lo = entryPx;
    hi = entryPx * 100;
  }

  const flo = f(lo);
  const fhi = f(hi);

  // If already below maintenance at entry, "immediate liquidation" in our model
  if (f(entryPx) <= 0) return 0;

  // If no sign change, can't solve reliably
  if (!(Number.isFinite(flo) && Number.isFinite(fhi)) || flo * fhi > 0) return null;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-8) return mid;
    if (flo * fm <= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Sum the initial-margin reserved by resting perp limit orders.
 * Trigger / stop orders (no `limitPx`) are excluded because HL doesn't
 * lock margin for them until they fire.
 */
export function computeOpenOrdersMarginUsd(orders: unknown[]): number {
  if (!Array.isArray(orders) || orders.length === 0) return 0;
  let total = 0;
  for (const o of orders as any[]) {
    if (!o || typeof o !== 'object') continue;
    const sz = Math.abs(parseFloat(o.sz ?? '0'));
    const px = parseFloat(o.limitPx ?? '0');
    if (sz <= 0 || px <= 0) continue;

    const mu = parseFloat(o.marginUsed ?? o.marginUsedUsd ?? '0');
    if (mu > 0) {
      total += mu;
      continue;
    }

    const lev = parseFloat(o.leverage ?? '0');
    if (lev > 0) {
      total += (sz * px) / lev;
    }
  }
  return total;
}

/**
 * Cross-margin liquidation price following Hyperliquid's official formula
 * (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations):
 *
 *   liq_price = mark - side * margin_available / position_size / (1 - l * side)
 *   margin_available_cross = account_value - maintenance_margin_required
 *   l = 1 / MAINTENANCE_LEVERAGE = 1 / (2 * max_leverage_for_tier)  ( == mmr )
 *
 * The crucial property is that `margin_available` is a SHARED scalar
 * across the cross pool — every cross position in the dex shares the
 * same `account_value − Σ maintenance_margin_required` value, and each
 * position's individual liq just plugs that scalar into the formula
 * with its own size / mark / side / mmr. Three consequences for projecting
 * a hypothetical fill on this dex:
 *
 *   1. With multiple cross positions, EVERY other cross position's
 *      maintenance margin must be subtracted from `account_value` too.
 *      Without it, `margin_available` is overestimated, projected liqs
 *      drift safer than HL's, and adding a new high-leverage position
 *      while other positions exist can show a far-too-safe liq (bug:
 *      e.g. preview said BTC short liq = 96k, real liq after fill 89k).
 *
 *   2. HL exposes the right scalar directly — `clearinghouseState` ships
 *      `crossMaintenanceMarginUsed` at the top level, which is exactly
 *      Σ maint_j over every OPEN cross position in the pool, computed
 *      at current marks against the live tier schedules. So:
 *
 *        current MA = crossMarginSummary.accountValue
 *                   − crossMaintenanceMarginUsed
 *
 *      This is authoritative — no client-side per-position mmr lookup,
 *      no schedule-per-asset, no rounding drift.
 *
 *   3. Resting open orders DO NOT enter the formula — HL's preview uses
 *      raw `crossMarginSummary.accountValue` and counts maintenance
 *      margin only on OPEN positions, not on resting orders.
 *
 * Three resolution modes, in order of preference:
 *
 *   • `anchor` mode (preferred when an existing same-asset position is
 *     present): back-solve `margin_available` from HL's reported
 *     `liquidationPx`, then apply the hypothetical fill's Δ maintenance.
 *     This makes compounding / reducing an existing position follow HL's
 *     own active-position value exactly.
 *
 *   • `pool` mode (required for a brand-new asset position): works whether
 *     or not the
 *     user has an existing position there): plug HL's reported scalars
 *     in directly. Apply only the incremental Δ maintenance margin from
 *     the hypothetical fill (positive when adding/compounding, negative
 *     when reducing).
 *
 *   • `accountValue`-only mode (last resort, single-position pool):
 *     margin_available = account_value − maint(this hypothetical
 *     position). Exact when this is the only cross position in the
 *     pool; otherwise overestimates safety.
 *
 * Maintenance margin uses the tiered schedule (notional·mmr − deduction).
 * We honour HL's docs: maintenance leverage depends on the tier
 * containing the position value AT the liquidation price. We use the
 * tier at mark; the difference vs. solving for the tier at liq is a tiny
 * second-order error that only matters near tier boundaries.
 */
export function estimateLiqPriceCross(args: {
  /** Current mark / oracle price of the asset. */
  markPx: number;
  /** Combined position side AFTER the hypothetical fill. */
  side: 'long' | 'short';
  /** Combined position absolute size AFTER the hypothetical fill, in units. */
  sizeUnits: number;
  schedule: MaintenanceScheduleTier[];
  /**
   * Existing OPEN cross position on THIS asset (if any). Used for two
   * things:
   *   - In `pool` mode: subtract its current maintenance margin from
   *     `crossMaintenanceMarginUsedUsd` so the incremental Δ is
   *     correct (HL already includes its maint in the pool total; the
   *     hypothetical fill replaces it with the combined position's maint).
   *   - In `anchor` fallback mode: back-solve `margin_available` from
   *     its reported `liquidationPx`.
   * Pass undefined for a brand-new position on this asset.
   */
  existing?: {
    /** Side of the existing position (NOT the hypothetical fill side). */
    side: 'long' | 'short';
    sizeUnits: number;
    liquidationPx: number;
    /** Current mark used by HL for the active position snapshot. */
    markPx?: number;
  };
  /**
   * `crossMarginSummary.accountValue` for THIS asset's dex pool.
   * Required for `pool` and `accountValue`-only modes.
   */
  accountValueUsd?: number;
  /**
   * `crossMaintenanceMarginUsed` for THIS asset's dex pool. Top-level
   * field on `clearinghouseState`. When present, enables the most
   * accurate `pool` mode — works regardless of whether the user has an
   * existing position on this asset.
   */
  crossMaintenanceMarginUsedUsd?: number;
}): number | null {
  const mark = args.markPx;
  const size = args.sizeUnits;
  const newSideSign = args.side === 'long' ? 1 : -1;

  if (!Number.isFinite(mark) || mark <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  if (!args.schedule?.length) return null;

  const newNotionalAtMark = size * mark;
  const newMaintAtMark = maintenanceMarginRequired(newNotionalAtMark, args.schedule);
  // mmr at the tier the new position lives in at mark. For positions
  // whose tier doesn't change between mark and liq (the common case),
  // this is exact; otherwise it's a small approximation.
  const newMmr = newNotionalAtMark > 0 ? newMaintAtMark / newNotionalAtMark : 0;
  const denom = 1 - newMmr * newSideSign;
  if (!(denom > 0)) return null;

  // Maint at mark for the same-asset existing position (if any). HL has
  // already counted this in `crossMaintenanceMarginUsed`, so swapping in
  // the post-fill combined-position maint means subtracting this and
  // adding `newMaintAtMark`.
  let existingMaintAtMark = 0;
  if (
    args.existing &&
    Number.isFinite(args.existing.sizeUnits) &&
    args.existing.sizeUnits > 0
  ) {
    existingMaintAtMark = maintenanceMarginRequired(
      args.existing.sizeUnits * mark,
      args.schedule,
    );
  }

  // ── 1. Determine margin_available at mark (post-fill) ──────────────
  let marginAvailableAtMark: number | null = null;

  // Path A — anchor mode. For stacking/reducing an existing same-asset
  // position, HL's active `liquidationPx` is the authoritative scalar
  // Deepseek described. Back-solve it first so a bad caller-side account
  // equity guess cannot make a stacked long look safer.
  if (
    args.existing &&
    Number.isFinite(args.existing.liquidationPx) &&
    args.existing.liquidationPx > 0 &&
    Number.isFinite(args.existing.sizeUnits) &&
    args.existing.sizeUnits > 0
  ) {
    const existing = args.existing;
    const existingSideSign = existing.side === 'long' ? 1 : -1;
    const existingNotionalAtMark = existing.sizeUnits * mark;
    const existingMmr =
      existingNotionalAtMark > 0 ? existingMaintAtMark / existingNotionalAtMark : 0;
    const existingDenom = 1 - existingMmr * existingSideSign;
    if (!(existingDenom > 0)) return null;

    // liq = mark - side * MA / size / (1 - mmr*side)
    //   ⇒ MA = (mark - liq) * size * (1 - mmr*side) / side
    const marginAvailableForExistingPool =
      ((mark - existing.liquidationPx) * existing.sizeUnits * existingDenom) /
      existingSideSign;
    const marginAvailableAtSnapshot =
      Number.isFinite(existing.markPx ?? NaN) &&
      (existing.markPx as number) > 0
        ? (((existing.markPx as number) - existing.liquidationPx) *
            existing.sizeUnits *
            existingDenom) /
          existingSideSign
        : marginAvailableForExistingPool;

    const deltaMaint = newMaintAtMark - existingMaintAtMark;
    const poolMarginAvailable =
      Number.isFinite(args.accountValueUsd ?? NaN) &&
      (args.accountValueUsd as number) > 0 &&
      Number.isFinite(args.crossMaintenanceMarginUsedUsd ?? NaN) &&
      (args.crossMaintenanceMarginUsedUsd as number) >= 0
        ? (args.accountValueUsd as number) - (args.crossMaintenanceMarginUsedUsd as number)
        : null;

    // Normally the active position's `liquidationPx` is the best anchor for
    // same-asset stacking, because it captures HL's exact current pool state.
    // But order preview can include a planned sendAsset top-up into this dex
    // before the order is placed. In that case the caller's pool scalar is
    // intentionally higher than the active-position anchor; use it so large
    // valid stack orders don't render as N/A.
    const currentMarginAvailable =
      poolMarginAvailable !== null && poolMarginAvailable > marginAvailableAtSnapshot + 1e-6
        ? marginAvailableForExistingPool + (poolMarginAvailable - marginAvailableAtSnapshot)
        : marginAvailableForExistingPool;
    marginAvailableAtMark = currentMarginAvailable - deltaMaint;
  }

  // Path B — pool mode. Uses HL's authoritative per-pool scalars, and is
  // required when opening a brand-new position on an asset with no anchor.
  if (
    marginAvailableAtMark === null &&
    Number.isFinite(args.accountValueUsd ?? NaN) &&
    (args.accountValueUsd as number) > 0 &&
    Number.isFinite(args.crossMaintenanceMarginUsedUsd ?? NaN) &&
    (args.crossMaintenanceMarginUsedUsd as number) >= 0
  ) {
    const av = args.accountValueUsd as number;
    const poolMaint = args.crossMaintenanceMarginUsedUsd as number;
    // poolMaint already includes the existing same-asset position's
    // maint (if any); replace it with the combined position's maint.
    const newPoolMaint = poolMaint - existingMaintAtMark + newMaintAtMark;
    marginAvailableAtMark = av - newPoolMaint;
  }

  // Path C — last resort: assume single-position pool.
  if (
    marginAvailableAtMark === null &&
    Number.isFinite(args.accountValueUsd ?? NaN) &&
    (args.accountValueUsd as number) > 0
  ) {
    marginAvailableAtMark = (args.accountValueUsd as number) - newMaintAtMark;
  }

  if (marginAvailableAtMark === null) return null;

  // If margin_available has gone non-positive after the fill, the
  // position would be immediately liquidatable. Do not return `mark`
  // here: that renders as "liq = live price" and looks like a real
  // liquidation level. For order-entry UI, N/A is safer and clearer.
  if (marginAvailableAtMark <= 0) return null;

  // ── 2. Apply HL's formula directly ──────────────────────────────────
  const liq = mark - (newSideSign * marginAvailableAtMark) / size / denom;
  if (!Number.isFinite(liq) || liq <= 0) return null;
  // Sanity guard: a valid long liq is below mark; a valid short liq is
  // above mark. If stale/partial inputs ever violate this, fail closed
  // instead of displaying an impossible liquidation price.
  if (args.side === 'long' && liq >= mark) return null;
  if (args.side === 'short' && liq <= mark) return null;
  return liq;
}
