/**
 * Funding carry context for winning/losing monitors.
 *
 * Goal: surface rate + dollars paid/received without letting a hot rate alone
 * force a cut on a winner whose dollar funding drag is still tiny vs gains.
 */

/** Accrued funding must clear both floors before it counts as a trim signal. */
export const FUNDING_DRAG_MIN_USD = 2;
export const FUNDING_DRAG_MIN_FRAC_OF_PNL = 0.15;

export interface FundingCarryContext {
  /** CoinGlass market funding (bps). */
  marketFundingBps: number | null;
  /** Market funding Δ vs nearest bar at / before entry (bps). */
  marketFundingChangeBps: number | null;
  /** HL assetCtx.funding in bps (current / next interval). */
  hlNextFundingBps: number | null;
  /**
   * Accrued funding from the user's perspective (matches PortfolioTabs):
   * positive = you received, negative = you paid.
   */
  fundingPnlUsd: number | null;
  unrealizedPnlUsd: number;
  direction: 'LONG' | 'SHORT';
}

/** True when the position is paying material funding vs open mark PnL. */
export function isFundingDragMaterial(ctx: FundingCarryContext): boolean {
  if (ctx.fundingPnlUsd == null || !(ctx.fundingPnlUsd < 0)) return false;
  const cost = Math.abs(ctx.fundingPnlUsd);
  const pnlAbs = Math.abs(ctx.unrealizedPnlUsd);
  return cost >= Math.max(FUNDING_DRAG_MIN_USD, FUNDING_DRAG_MIN_FRAC_OF_PNL * Math.max(pnlAbs, 1));
}

/** HL/market funding sign that costs this side (longs pay when funding > 0). */
export function fundingRateAgainstSide(
  fundingBps: number | null,
  direction: 'LONG' | 'SHORT',
): boolean {
  if (fundingBps == null || !Number.isFinite(fundingBps)) return false;
  if (direction === 'LONG') return fundingBps > 0;
  return fundingBps < 0;
}

function fmtUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtBps(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)} bps`;
}

/**
 * Prompt block: numbers + anti-overreaction rules shared by win/lose monitors.
 */
export function renderFundingCarrySection(ctx: FundingCarryContext): string {
  const paid = ctx.fundingPnlUsd;
  const pnlAbs = Math.abs(ctx.unrealizedPnlUsd);
  let dragLine = 'N/A';
  if (paid != null && Number.isFinite(paid)) {
    if (pnlAbs < 1e-6) {
      dragLine = `${fmtUsd(paid)} accrued (mark PnL ~ flat — compare to notional, not %)`;
    } else {
      const pctOfPnl = (Math.abs(paid) / pnlAbs) * 100;
      const material = isFundingDragMaterial(ctx);
      dragLine = `${fmtUsd(paid)} accrued (= ${pctOfPnl.toFixed(0)}% of |unrealized|)${
        material ? ' — MATERIAL drag' : ' — not material vs open PnL'
      }`;
    }
  }

  const againstMarket = fundingRateAgainstSide(ctx.marketFundingBps, ctx.direction);
  const againstHl = fundingRateAgainstSide(ctx.hlNextFundingBps, ctx.direction);
  const receiving = paid != null && paid > 0;

  return `
**FUNDING CARRY** (Hyperliquid position + market rate):
- Accrued funding (your P&L, Portfolio sign): ${dragLine}
- Market funding: ${fmtBps(ctx.marketFundingBps)} (Δ since entry: ${fmtBps(ctx.marketFundingChangeBps)})
- Next / current HL funding: ${fmtBps(ctx.hlNextFundingBps)} (positive ⇒ longs pay shorts)
- vs your ${ctx.direction}: market ${againstMarket ? 'AGAINST' : 'with/neutral'}, HL ${againstHl ? 'AGAINST' : 'with/neutral'}${
    receiving ? '; you are RECEIVING funding' : ''
  }

**FUNDING RULES** (do NOT overreact):
- Rate alone is NEVER enough to ${ctx.unrealizedPnlUsd < 0 ? 'CUT a losing position' : 'EXIT a winning position'}.
- A hot rate may count as **one soft trim signal** ONLY if accrued funding cost is MATERIAL: paid ≥ max($${FUNDING_DRAG_MIN_USD}, ${Math.round(FUNDING_DRAG_MIN_FRAC_OF_PNL * 100)}% of |unrealized PnL|) AND rate is still against your side.
- If |accrued funding| is tiny vs the open ${ctx.unrealizedPnlUsd < 0 ? 'loss' : 'gain'}, IGNORE funding for action choice — you may mention it in the reason, but do not trim/exit for it.
- If you are receiving funding, treat elevated |rate| as supportive carry, not a warning.
- Next HL funding is near-term carry context, not a hard exit trigger.
`.trim();
}
