/**
 * Trading horizon — the TIME STRUCTURE of an agent (orthogonal to
 * riskProfile, which is entry appetite). Worker cycles hourly for all modes;
 * differentiation is parameterization + which looks actually call the LLM:
 *
 *   scalper  — hours-scale: hourly opens + hourly monitors, tight/medium stops
 *   swing    — days-scale: hourly opens (catch structure shifts), hourly
 *              monitors, loose stops, 2R+
 *   investor — weeks/month+ (esp. HIP-3): hourly opens (catch options/macro),
 *              4h monitors by default (ignore hourly chop) with a thin risk
 *              fast-path; wider geometry, EMA-heavy temperament, ≤3x opens
 */

import { takerFlowInFeed } from './takerFlow.js';

export type Horizon = 'scalper' | 'swing' | 'investor';

export function normalizeHorizon(raw: unknown): Horizon {
  if (raw === 'swing') return 'swing';
  if (raw === 'investor') return 'investor';
  return 'scalper';
}

export interface HorizonProfile {
  key: Horizon;
  /**
   * Opening-decision window (flat-memo divisor): how often a FLAT answer is
   * allowed to re-ask. All horizons 1h — entries need to catch options/macro
   * shifts; patience lives in geometry + investor's slower monitor window.
   */
  openingWindowMs: number;
  /**
   * In-position monitor window: how often the LLM re-manages an open trade.
   * Investor 4h (multi-week thesis — hourly re-asks are noise); others 1h.
   * Worker still wakes hourly; mid-window ticks are skipped unless a risk
   * fast-path fires (liq distance, earnings ≤48h, thesis already WEAKENED/
   * INVALIDATED, near stop).
   */
  monitorWindowMs: number;
  /** Multiplier for flag lookback windows (flow/OI/CVD/trend anchors). */
  flagWindowScale: number;
  /** planStops hint — 'medium' preserves pre-horizon scalper behavior. */
  stopHint: 'tight' | 'medium' | 'loose';
  /** Validator take-profit floor, in R. */
  tpFloorR: number;
  /** Prompt text for the TP guidance line. */
  tpGuidance: string;
  /** Multiplier applied to the monitor prompts' price-% loss/trim thresholds. */
  monitorThresholdMult: number;
  /** Move-to-breakeven trigger (price-% P&L). */
  breakevenPct: number;
  /** Tighten-stop trigger (price-% P&L). */
  tightenPct: number;
  /**
   * Hard opening-conviction floor (worker-enforced, mirrored in prompt).
   * null → risk-profile gate alone decides.
   */
  minConvictionGate: number | null;
  /** Probe tier under the gate (tiny exploratory size). Investor: none. */
  allowProbes: boolean;
  /** Engine cap on open leverage (null → agent cap alone). */
  maxOpenLeverage: number | null;
  /** No re-open on a symbol for this long after a loss-close (churn brake). */
  reopenCooldownMs: number;
}

const HOUR = 60 * 60 * 1000;

export const HORIZON_PROFILES: Record<Horizon, HorizonProfile> = {
  scalper: {
    key: 'scalper',
    openingWindowMs: HOUR,
    monitorWindowMs: HOUR,
    flagWindowScale: 1,
    stopHint: 'medium',
    tpFloorR: 1.5,
    tpGuidance: 'at least 1.5R from entry (aim 1.5–2R)',
    monitorThresholdMult: 1,
    breakevenPct: 1,
    tightenPct: 2,
    minConvictionGate: null,
    allowProbes: true,
    maxOpenLeverage: null,
    reopenCooldownMs: 1 * HOUR,
  },
  swing: {
    key: 'swing',
    openingWindowMs: HOUR,
    monitorWindowMs: HOUR,
    flagWindowScale: 4,
    stopHint: 'loose',
    tpFloorR: 2,
    tpGuidance: 'at least 2R from entry (aim 2–3R — swing theses need room to pay)',
    monitorThresholdMult: 2.5,
    breakevenPct: 3,
    tightenPct: 5,
    minConvictionGate: null,
    allowProbes: true,
    maxOpenLeverage: null,
    reopenCooldownMs: 1 * HOUR,
  },
  investor: {
    key: 'investor',
    // Hourly opens: options/macro/daily structure can flip any hour.
    // 4h monitors: multi-week thesis shouldn't be re-litigated every hour.
    openingWindowMs: HOUR,
    monitorWindowMs: 4 * HOUR,
    flagWindowScale: 6,
    stopHint: 'loose',
    tpFloorR: 3,
    tpGuidance: 'at least 3R from entry (aim 3–5R — multi-week theses need room)',
    monitorThresholdMult: 4,
    breakevenPct: 5,
    tightenPct: 8,
    // 40: the thesis-persistence guard made investor exits evidence-gated
    // (cut/flip need INVALIDATED or ≥2/3 triggers) — positions that are hard
    // to exit must be harder to enter. Raise to 45 once enough closed
    // investor trades exist to calibrate the 40-50 conviction band. No probe
    // tier — a probe-conviction multi-week hold is incoherent.
    minConvictionGate: 40,
    allowProbes: false,
    maxOpenLeverage: 3,
    reopenCooldownMs: 2 * HOUR,
  },
};

export function horizonProfile(raw: unknown): HorizonProfile {
  return HORIZON_PROFILES[normalizeHorizon(raw)];
}

/** Opening-prompt block. */
export function renderOpeningHorizonSection(h: Horizon): string {
  if (h === 'investor') {
    return `

**TRADING HORIZON: INVESTOR** (weeks to month+ — patient trend capture):
- Opening looks every hour (catch options/macro/daily shifts), but you HOLD for weeks when the thesis is intact. In-position management runs on a slower ~4h cadence unless risk/invalidation fires.
- Flow windows are WIDENED (×6). Weight **daily structure + listed options + macro (earnings, DXY/SP500, calendar)** over 1h microstructure chop. HIP-3 venue OI is not a thesis signal.
- Prefer entries WITH the multi-week structure; skip counter-trend scalps even when short-term flow tempts.
- Stops are LOOSE (daily-structure / session-range) and targets ≥ 3R. Leverage should stay low (≤3x guidance) so wide stops are survivable.
- Off-session / discovery-bound drift on HIP-3 is noise unless invalidation or liquidation risk fires.`;
  }
  if (h === 'swing') {
    return `

**TRADING HORIZON: SWING** (days-scale — the user chose patient trend capture):
- Your ${takerFlowInFeed() ? 'flow/OI/CVD' : 'OI and premium'} windows are WIDENED (×4): "3-bar" here spans 12 hours. Judge structure, not the last candle.
- Expected hold: 1–7 days. Opening looks every hour (catch structure/flow shifts), but only take setups worth holding through overnight chop — patience is in the geometry, not in ignoring fresh alpha.
- Prefer entries WITH the multi-day structure (ETF flows, positioning, trend consistency); skip counter-trend scalps even when short-term flow tempts.
- Stops are session-range LOOSE and targets ≥ 2R — do not propose tight scalp stops that normal daily range would clip.`;
  }
  return `

**TRADING HORIZON: SCALPER** (hours-scale):
- Expected hold: a few hours to a day. React to ${takerFlowInFeed() ? 'microstructure (flow, CVD, liq clusters)' : 'open interest, premium, liquidations, and listed options when this contract has them'}; take profits into strength; do not marry positions.`;
}

/**
 * Monitor-prompt block. Investor/swing text is load-bearing: an hourly
 * monitor staring at a long thesis is tempted to micro-manage.
 */
export function renderMonitorHorizonSection(h: Horizon): string {
  if (h === 'investor') {
    return `

**TRADING HORIZON: INVESTOR** (multi-week thesis):
- This position is MEANT to be held for weeks. The engine only re-asks you about every 4 hours (unless liquidation distance, earnings ≤48h, a near stop, or an already-WEAKENED/INVALIDATED thesis forces an early look). Adverse hours are noise unless invalidation fired.
- All % thresholds in this prompt are pre-scaled for investor. Do NOT act tighter out of discomfort. Default HOLD.
- Judge on the daily structure (20/50/200d stack, 52w position, RS), macro beta, and thesis invalidation — not the last bar's flow. Off-session HIP-3 drift inside discovery bounds is not confirmation or invalidation by itself.
- HIP-3: ignore venue OI for thesis; venue liquidation clusters are noise on investor horizon unless YOUR liq distance is threatened.
- ENFORCED by the engine: cut/flip require thesis INVALIDATED or ≥2 cut triggers (HIP-3: premium+flow only); trim requires WEAKENED + ≥1 trigger. Anything weaker is downgraded — cite the specific fired criterion, not "I wouldn't enter fresh here".`;
  }
  if (h === 'swing') {
    return `

**TRADING HORIZON: SWING** (days-scale thesis):
- This position is MEANT to be held for days. An adverse hour — or day — is noise unless an invalidation criterion fired or liquidation distance is threatened.
- All % thresholds in this prompt are pre-scaled for swing. Do NOT act tighter than them out of discomfort. Default HOLD; trims are for invalidation evidence, not drawdown anxiety.
- Judge the thesis on multi-day structure (trend consistency, ETF flows, positioning), not the last bar's flow.
- HIP-3: venue OI is not a thesis/cut signal; venue liquidation clusters are local squeeze/cascade fuel only (not global options liqs).
- ENFORCED by the engine: cut/flip require thesis INVALIDATED or ≥2 cut triggers (HIP-3: premium+flow only); trim requires thesis ≠ INTACT. Anything weaker is downgraded — cite the specific fired criterion, not "I wouldn't enter fresh here".`;
  }
  return `

**TRADING HORIZON: SCALPER** (hours-scale):
- Manage actively: protect gains quickly, cut invalidated trades fast. Thresholds in this prompt are calibrated for hours-scale holds.`;
}
