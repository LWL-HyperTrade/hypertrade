import type { SessionContext } from '../session-context.js';
import { fmtUsd, renderEtfFlowsSection, type EtfFlowsContext } from '../../data/etfFlows.js';
import { renderHlPositioningSection, type HlPositioningContext } from '../../data/hlPositioning.js';
import { renderWhaleSection, type WhalePos } from '../../data/hlWhales.js';
import { HORIZON_PROFILES, normalizeHorizon, renderMonitorHorizonSection, type Horizon } from '../horizon.js';
import { takerFlowInFeed } from '../takerFlow.js';
import { normalizeDirection, normalizeMandate, renderMonitorMandateSection, type Direction, type Mandate } from '../mandate.js';
import { renderCalendarSection } from '../../data/macroCalendar.js';
import {
  renderStickyNarrativesSection,
  type StickyNarrativesBoard,
} from '../../data/stickyNarratives.js';
import {
  renderStickySymbolCatalystsSection,
  type StickySymbolCatalysts,
} from '../../data/stickySymbolCatalysts.js';
import { renderEmaSection, type EmaContext } from '../../data/emaList.js';
import {
  renderCryptoExtensionSection,
  type CryptoExtensionContext,
} from '../../data/cryptoExtension.js';
import { renderEarningsSection, type EarningsContext } from '../../data/earnings.js';
import {
  renderEquityOptionsSection,
  isMetalsOptionsAsset,
  type EquityOptionsContext,
} from '../../data/equityOptions.js';
import {
  renderEquityDailySection,
  type EquityDailyContext,
} from '../../data/equityDaily.js';
import {
  getXyzSessionContext,
  renderXyzSessionSection,
} from '../../data/xyzSession.js';
import { assetClassOf, coinPart, isCryptoAsset } from '../assetClass.js';
import { supportsDeribitDvol } from '../../data/deribit.js';
import { MONITOR_SUMMARY_FIELD_RULE, sanitizeMonitorSummary } from './sanitizeSummary.js';
import { buildLeverageRiskSection } from './leverage-risk.js';
import {
  renderFundingCarrySection,
  type FundingCarryContext,
} from './funding-carry.js';

/**
 * TIER 2b: LOSING POSITION MONITOR
 *
 * Goal: Determine if thesis is INVALIDATED or if this is just noise.
 * May DCA (average down) only when thesis is intact and chop — never a
 * synonym for winning-monitor ADD.
 */

export interface LosingMonitorInput {
  asset: string
  position: {
    direction: 'LONG' | 'SHORT'
    entry_price: number
    current_price: number
    size: number
    leverage: number
    unrealized_pnl: number // Negative value
    unrealized_pnl_pct: number // Negative % loss (PRICE move, not leveraged)
    duration_minutes: number
    distance_to_stop: number // % distance to stop-loss
    // Leverage-risk context (optional — legacy callers may omit)
    roe_pct?: number // leveraged return on margin (price % × leverage)
    margin_usd?: number // collateral backing this position (notional / leverage)
    liquidation_price?: number | null
    liquidation_distance_pct?: number | null // |liq − current| / current × 100
  }
  original: {
    conviction: number
    stop_loss: number
    take_profit: number
    invalidation_criteria: string[]
    /** The opening model's reasoning for entering this trade. */
    reasoning?: string
  }
  updatedData: {
    spot_price: number
    /** CoinGlass market funding in bps (not a decimal fraction). */
    funding_rate_bps: number | null
    /** Δ market funding bps vs nearest bar at entry. */
    funding_rate_change_bps: number | null
    /** HL assetCtx.funding in bps. */
    hl_next_funding_bps: number | null
    /**
     * Accrued funding, user perspective (PortfolioTabs): + received, − paid.
     */
    funding_pnl_usd: number | null
    /** Real last-bar liquidation $ (longs = longs liquidated); null = no data. */
    liquidations_1h: { longs: number; shorts: number } | null
    /** DVOL pts since entry; null when entry predates the IV window. */
    iv_change: number | null
    /** Perp-spot premium drift since entry (bps); null when entry bar unknown. */
    basis_change_bps: number | null
    invalidation_status: {
      criteria: string
      triggered: boolean
      current_value: string
    }[]
    // Enhanced market data for detailed analysis
    flowRatio?: number
    oiDeltaPct?: number
    premiumBps?: number
    ivDelta?: number
    cvdNet24Usd?: number | null
    spotCvdNet24Usd?: number | null
    cvdDivergence?: 'bullish' | 'bearish' | 'none' | 'na'
    regime?: {
      volatilityState: 'low' | 'normal' | 'high'
      liquidityState: 'thin' | 'normal' | 'thick'
      trendConsistency: number
      chopRisk: boolean
      rangeCompression: boolean
    }
  }
  /** Daily spot-ETF flow context (BTC/ETH/SOL/XRP only, else null). */
  etfFlows?: EtfFlowsContext | null
  /** Platform-wide HL cohort positioning (globally cached). Crypto only. */
  hlPositioning?: HlPositioningContext | null
  /** HL $1M+ whale positions — per-symbol bias + liq clusters. */
  whalePositions?: WhalePos[] | null
  ema?: EmaContext | null
  earnings?: EarningsContext | null
  /** Listed US options chain metrics (Massive) — equity HIP-3 only. */
  equityOptions?: EquityOptionsContext | null
  /** Real US daily-bar trend context (Massive aggs) — equity/metals HIP-3. */
  equityDaily?: EquityDailyContext | null
  /** Global sticky macro/theme board (2×/day cache). */
  stickyNarratives?: StickyNarrativesBoard | null
  /** Per-ticker sticky catalysts (Clarity Act, partnerships, unlocks, …). */
  stickySymbolCatalysts?: StickySymbolCatalysts | null
  /** Crypto-only stretch / exhaustion (RSI + EMA + wall-clock pctls). */
  cryptoExtension?: CryptoExtensionContext | null
  /** Time structure — scales the loss thresholds below. */
  horizon?: Horizon
  /** Allowed sides (worker-enforced; disallowed flip → cut). */
  direction?: Direction
  /** active (default) | accumulate. */
  mandate?: Mandate
  positionHistory: {
    checks_count: number // Number of monitoring checks performed
    last_check_time: string // When was last check
    previous_decisions: Array<{
      timestamp: string
      action: string
      reasoning: string
      pnl_pct: number
      /** Thesis conviction (0-100) reported at that check; null on legacy rows. */
      thesis_conviction?: number | null
      engineNote?: string
    }> // Last 3 monitoring decisions
    /** Successful DCA count on this position (max 2). */
    dca_count?: number
    /** Successful trim count (max 3) — same cap as winning monitor. */
    trim_count?: number
  }
  sessionContext: SessionContext
}

export interface LosingMonitorOutput {
  action: 'hold' | 'cut' | 'flip' | 'trim' | 'dca'
  flipSide?: 'LONG' | 'SHORT' // If action is 'flip'
  trimPct?: number // 0.25-0.50 (if action is 'trim')
  /** Fraction of opening-size base to add (0.15–0.33) when action is dca. */
  dcaSize?: number
  newStop?: 'breakeven' | 'tighter'
  reason: string
  /** 1-2 plain-English sentences for non-technical readers (display-only). */
  summary?: string
  confidence: number
  metrics: {
    oiContinues: boolean
    premiumSameSign: boolean
    flowSameSide: boolean
  }
  thesis_status: 'INTACT' | 'WEAKENED' | 'INVALIDATED'
  /**
   * Current belief in the ORIGINAL entry thesis (0-100), anchored to the
   * opening conviction — distinct from `confidence` (which scores the action).
   * Null when the model omitted it or returned garbage.
   */
  thesis_conviction: number | null
  cutTriggers: {
    oiAgainst: boolean // OI moves against side by ≥ 1% over last 2 bars
    premiumFlip: boolean // Premium flips through 0 opposite your side or pushes ≥ 10 bps against you
    oppositeFlow: boolean // sell$ / buy$ ≥ 1.6 for longs (inverse for shorts)
  }
  emotional_check: 'RATIONAL' | 'HOPEFUL' | 'PANIC' // Self-assessment
}

export function buildLosingMonitorPrompt(input: LosingMonitorInput): string {
  const displayAsset = coinPart(input.asset)
  const optionsInScope = supportsDeribitDvol(input.asset)
  const isEquity = assetClassOf(input.asset) === 'equity'
  const isMetals = isMetalsOptionsAsset(input.asset)
  const hasEquityOptions = isEquity && input.equityOptions != null
  const hasMetalsOptions = isMetals && input.equityOptions != null
  const hasListedOptions = hasEquityOptions || hasMetalsOptions
  const isHip3Listed = isEquity || isMetals
  const flowInFeed = takerFlowInFeed()
  const equityOptionsBlock = renderEquityOptionsSection(input.equityOptions, {
    equity: isEquity,
    metals: isMetals,
  })
  const horizon = normalizeHorizon(input.horizon)
  const hip3LiqRelevant = isHip3Listed && horizon !== 'investor'
  // Horizon multiplier: swing positions are MEANT to breathe — thresholds
  // scale up so an hourly monitor doesn't panic-trim a days-scale thesis.
  // Non-crypto floor at swing's multiplier: crypto-calibrated % thresholds
  // read fee-level equity wiggles as invalidation (live TSLA churn).
  const hm = isCryptoAsset(input.asset)
    ? HORIZON_PROFILES[horizon].monitorThresholdMult
    : Math.max(
        HORIZON_PROFILES[horizon].monitorThresholdMult,
        HORIZON_PROFILES.swing.monitorThresholdMult,
      )
  const horizonSection = renderMonitorHorizonSection(horizon)
  const mandateSection = renderMonitorMandateSection(
    normalizeDirection(input.direction),
    normalizeMandate(input.mandate),
  )
  const timeHeld = (input.position.duration_minutes / 60).toFixed(1)
  const lossAmount = Math.abs(input.position.unrealized_pnl)
  // Loss relative to the margin actually backing THIS position (was a
  // hard-coded $250 "max daily loss" from the legacy $5k bot — meaningless
  // and miscalibrating for small agents).
  const marginUsd =
    typeof input.position.margin_usd === 'number' &&
    Number.isFinite(input.position.margin_usd) &&
    input.position.margin_usd > 0
      ? input.position.margin_usd
      : null
  const lossVsMarginText = marginUsd
    ? `${((lossAmount / marginUsd) * 100).toFixed(1)}% of the $${marginUsd.toFixed(2)} margin backing this position`
    : 'N/A (margin unknown)'
  const hasOriginalStop = typeof input.original.stop_loss === 'number' && Number.isFinite(input.original.stop_loss) && input.original.stop_loss > 0
  const stopLossText = hasOriginalStop
    ? `$${input.original.stop_loss.toLocaleString()}`
    : 'N/A (not recorded)'
  const hasOriginalTP = typeof input.original.take_profit === 'number' && Number.isFinite(input.original.take_profit) && input.original.take_profit > 0
  const takeProfitText = hasOriginalTP
    ? `$${input.original.take_profit.toLocaleString()}`
    : 'N/A (not recorded)'
  const convictionText =
    typeof input.original.conviction === 'number' && input.original.conviction > 0
      ? `${input.original.conviction}%`
      : 'N/A (legacy trade)'
  const openingConviction =
    typeof input.original.conviction === 'number' && input.original.conviction > 0
      ? Math.round(input.original.conviction)
      : null
  const priorConvictions = input.positionHistory.previous_decisions
    .map(d => d.thesis_conviction)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
  const convictionTrajectory = openingConviction != null
    ? `${openingConviction} (open)${priorConvictions.length ? ` → ${priorConvictions.join(' → ')} (last checks)` : ' — first conviction reading since open'}`
    : priorConvictions.length
      ? `unknown (legacy open) → ${priorConvictions.join(' → ')} (last checks)`
      : null
  
  // Invalidation: pre-evaluated statuses when the caller computed them,
  // otherwise render the stored criteria and have the model evaluate each
  // one itself against the updated market data.
  const triggeredCriteria = input.updatedData.invalidation_status.filter(c => c.triggered)
  const hasInvalidation = triggeredCriteria.length > 0
  const invalidationBlock = input.updatedData.invalidation_status.length > 0
    ? input.updatedData.invalidation_status.map(c =>
        `${c.triggered ? '🔴 TRIGGERED' : '✅ OK'}: ${c.criteria} (Current: ${c.current_value})`
      ).join('\n')
    : input.original.invalidation_criteria.length > 0
      ? `Evaluate EACH criterion below YOURSELF against the updated market data. If any is clearly met, treat it as a hard invalidation:\n${input.original.invalidation_criteria.map(c => `- ${c}`).join('\n')}`
      : 'None recorded for this position — judge thesis validity from the market data alone.'
  const regime = input.updatedData.regime
  const regimeSection = regime
    ? `

**REGIME CONTEXT**:
- Volatility: **${regime.volatilityState.toUpperCase()}**${regime.volatilityState === 'low' ? ' (compression)' : regime.volatilityState === 'high' ? ' (expansion)' : ''}
- Liquidity: **${regime.liquidityState.toUpperCase()}**
- Trend Consistency: ${(regime.trendConsistency * 100).toFixed(0)}%
- Chop Risk: ${regime.chopRisk ? '⚠️ ACTIVE — avoid emotional cuts, focus on stop discipline' : 'No'}
- Range Compression: ${regime.rangeCompression ? 'Yes (expect fake-outs)' : 'No'}`
    : ''
  const session = input.sessionContext
  const sessionSection = session
    ? `

**SESSION CONTEXT**:
- Session: **${session.label.toUpperCase()}** (${session.sessionWindowUTC})
- US Session Active: ${session.isUsSession ? 'Yes' : 'No — expect thinner liquidity & delayed confirmation'}
- Thin hours (Fri 19:00–Sun 21:00 UTC): ${session.isWeekend ? '⚠️ YES — protect capital, expect higher slippage' : 'No'}`
    : ''
  const fundingCtx: FundingCarryContext = {
    marketFundingBps: input.updatedData.funding_rate_bps,
    marketFundingChangeBps: input.updatedData.funding_rate_change_bps,
    hlNextFundingBps: input.updatedData.hl_next_funding_bps,
    fundingPnlUsd: input.updatedData.funding_pnl_usd,
    unrealizedPnlUsd: input.position.unrealized_pnl,
    direction: input.position.direction,
  }
  const fundingSection = renderFundingCarrySection(fundingCtx)
  const dcaCount = input.positionHistory.dca_count ?? 0
  const trimCount = input.positionHistory.trim_count ?? 0
  const dcasLeft = Math.max(0, 2 - dcaCount)
  const lossCapNoStop = (2 * hm) % 1 === 0 ? String(2 * hm) : (2 * hm).toFixed(1)

  return `
You are monitoring a **LOSING ${input.position.direction}** position on ${displayAsset}.

⚠️ **THIS IS A CRITICAL MOMENT**. You must be BRUTALLY HONEST and EMOTIONLESS.

**POSITION STATUS**:
- Direction: **${input.position.direction}**
- Entry: $${input.position.entry_price.toLocaleString()}
- Current: $${input.position.current_price.toLocaleString()} ${input.position.direction === 'LONG' ? '📉' : '📈'}
- Unrealized P&L: **${input.position.unrealized_pnl_pct.toFixed(2)}%** price move (-$${lossAmount.toFixed(2)})
- **Loss vs Margin**: ${lossVsMarginText}
- Distance to Stop-Loss: ${input.position.distance_to_stop.toFixed(2)}%
- Time Held: ${timeHeld} hours
${buildLeverageRiskSection(input.position)}

**ORIGINAL THESIS**:
- Conviction: ${convictionText}
- Entry Reasoning: ${input.original.reasoning?.trim() ? `"${input.original.reasoning.trim()}"` : 'N/A (not recorded)'}
- Stop-Loss: ${stopLossText}
- Take-Profit: ${takeProfitText}

**INVALIDATION CHECK**:
${invalidationBlock}

${hasInvalidation ? '\n⚠️ **WARNING: INVALIDATION CRITERIA TRIGGERED!**\n' : ''}

**UPDATED MARKET DATA**:
- Spot Price: $${input.updatedData.spot_price.toLocaleString()}
${!isHip3Listed
    ? `- Liquidations (last 1h bar): ${input.updatedData.liquidations_1h ? `Longs: $${(input.updatedData.liquidations_1h.longs / 1e6).toFixed(2)}M, Shorts: $${(input.updatedData.liquidations_1h.shorts / 1e6).toFixed(2)}M` : 'N/A (no liquidation data for this symbol)'}\n`
    : hip3LiqRelevant
      ? `- Venue liquidations (last 1h, HL/tradeXYZ leverage map — squeeze/cascade fuel only, not thesis): ${input.updatedData.liquidations_1h ? `Longs flushed: $${(input.updatedData.liquidations_1h.longs / 1e6).toFixed(2)}M, Shorts flushed: $${(input.updatedData.liquidations_1h.shorts / 1e6).toFixed(2)}M` : 'N/A'}\n`
      : `- Venue liquidations: ignore for investor thesis (noise unless YOUR liquidation distance is threatened)\n`}
${optionsInScope
    ? `- IV Change since entry: ${input.updatedData.iv_change != null ? `${input.updatedData.iv_change > 0 ? '+' : ''}${input.updatedData.iv_change.toFixed(2)} pts` : 'N/A (entry predates the IV window)'}`
    : hasEquityOptions
      ? `- Options: listed US equity options are PRIMARY for ${displayAsset} — see EQUITY OPTIONS next (omit thin venue OI from reason)`
      : hasMetalsOptions
        ? `- Options: GLD/SLV metals options + DXY are PRIMARY for ${displayAsset} — see METALS OPTIONS next (omit thin venue OI; no corporate earnings)`
        : `- Options/IV: out of scope for ${displayAsset} (Deribit DVOL is BTC/ETH only — not a feed outage)`}
- Basis Change since entry: ${input.updatedData.basis_change_bps != null ? `${input.updatedData.basis_change_bps > 0 ? '+' : ''}${input.updatedData.basis_change_bps.toFixed(1)} bps` : 'N/A'}
${hasListedOptions ? equityOptionsBlock : ''}
${regimeSection}
${sessionSection}${renderXyzSessionSection(getXyzSessionContext(input.asset))}${renderCalendarSection(input.sessionContext?.upcomingEvents, undefined, { forEquity: isEquity || isMetals })}${renderStickyNarrativesSection(input.stickyNarratives)}${renderStickySymbolCatalystsSection(input.stickySymbolCatalysts)}${input.equityDaily ? renderEquityDailySection(input.equityDaily) : renderEmaSection(input.ema, { hip3: !isCryptoAsset(input.asset) })}${renderEarningsSection(input.earnings, { equity: isEquity })}${hasListedOptions ? '' : equityOptionsBlock}${isCryptoAsset(input.asset) ? renderEtfFlowsSection(input.etfFlows) : ''}${isCryptoAsset(input.asset) ? renderHlPositioningSection(input.hlPositioning) : ''}${isCryptoAsset(input.asset) ? renderCryptoExtensionSection(input.cryptoExtension) : ''}${renderWhaleSection(input.whalePositions, input.asset, input.position.current_price)}${horizonSection}${mandateSection}

${fundingSection}
**DETAILED MARKET ANALYSIS** (for user transparency):
${flowInFeed
  ? `- **Flow Dynamics**: Current flow ratio shows ${input.updatedData.flowRatio != null && Number.isFinite(input.updatedData.flowRatio) ? `${input.updatedData.flowRatio.toFixed(2)} (${input.updatedData.flowRatio > 1.2 ? 'BUY DOMINANT' : input.updatedData.flowRatio < 0.8 ? 'SELL DOMINANT' : 'BALANCED'})` : 'N/A (unavailable — not a balanced tape)'}
${!isHip3Listed
    ? `- **Flow Path (CVD, 24-bar)**: futures ${input.updatedData.cvdNet24Usd != null ? fmtUsd(input.updatedData.cvdNet24Usd) : 'N/A'}, spot ${input.updatedData.spotCvdNet24Usd != null ? fmtUsd(input.updatedData.spotCvdNet24Usd) : 'N/A'} | divergence: ${input.updatedData.cvdDivergence === 'bearish' ? 'BEARISH (buyers absorbed — upside fragile)' : input.updatedData.cvdDivergence === 'bullish' ? 'BULLISH (sellers absorbed — downside fragile)' : input.updatedData.cvdDivergence === 'none' ? 'none' : 'N/A'}`
    : ''}`
  : ''}
${isHip3Listed
    ? ''
    : `- **Open Interest**: OI change of ${input.updatedData.oiDeltaPct ? input.updatedData.oiDeltaPct.toFixed(2) : 'N/A'}% (${input.updatedData.oiDeltaPct && input.updatedData.oiDeltaPct > 1 ? 'STRONG BUILDUP' : input.updatedData.oiDeltaPct && input.updatedData.oiDeltaPct < -1 ? 'LIQUIDATION WAVE' : 'STABLE'})\n`}
- **Premium Analysis**: Premium at ${(() => {
  const p = input.updatedData.premiumBps
  if (p == null || !Number.isFinite(p)) return 'N/A'
  const tag = p >= 5 ? 'FUTURES OVERPRICED' : p <= -5 ? 'FUTURES UNDERPRICED' : 'FAIR VALUE'
  return p.toFixed(1) + ' bps (' + tag + ')'
})()}
${optionsInScope
    ? '- **Volatility Regime**: ' + (() => {
        const d = input.updatedData.ivDelta
        if (d == null || !Number.isFinite(d)) return 'IV this bar: N/A'
        const tone = d >= 3 ? 'EXPANDING' : d <= -1 ? 'COMPRESSING' : 'little changed'
        const fear = d >= 3 ? 'FEAR SPIKING' : d <= -1 ? 'COMPLACENCY' : 'NORMAL'
        return 'IV this bar ' + tone + ' by ' + Math.abs(d).toFixed(2) + ' pts (this bar only — since-entry change is above) (' + fear + ')'
      })()
    : hasEquityOptions
      ? `- **Options**: Lead "reason" with EQUITY OPTIONS (ATM IV / skew / put-call). Omit venue OI from reason (do not write that it is N/A).`
      : hasMetalsOptions
        ? `- **Options**: Lead "reason" with METALS OPTIONS (GLD/SLV) + DXY. Omit venue OI; no corporate earnings.`
        : `- **Options**: Not applicable for ${displayAsset}. Do not cite missing IV/options in your reason.`}
${!isHip3Listed
    ? '- **Liquidation Pressure**: ' + (() => {
        const liq = input.updatedData.liquidations_1h
        if (!liq) return 'N/A — do not cite liquidation pressure in your reason'
        if (Math.max(liq.longs, liq.shorts) < 100_000) return 'quiet last bar — do not cite a flush'
        const side = liq.longs > liq.shorts ? 'longs being flushed' : 'shorts being flushed'
        const mag = Math.abs(liq.longs - liq.shorts) / 1e6 > 5 ? 'HIGH' : 'moderate'
        return side + ' (' + mag + ' imbalance last bar)'
      })() + '\n'
    : hip3LiqRelevant
      ? `- **Venue liq pressure**: ${input.updatedData.liquidations_1h ? `${input.updatedData.liquidations_1h.longs > input.updatedData.liquidations_1h.shorts ? 'longs flushed' : 'shorts flushed'} last bar — local HL fuel only, not a cut trigger by itself` : 'N/A'}\n`
      : ''}
- **Basis Analysis**: ${(() => {
  const d = input.updatedData.basis_change_bps
  if (d == null || !Number.isFinite(d)) return 'N/A — entry bar outside data window'
  const side = input.position.direction
  const against = side === 'SHORT' ? d > 0 : d < 0
  const shift = Math.abs(d) > 10 ? 'SIGNIFICANT' : 'small'
  return 'premium moved ' + (d > 0 ? '+' : '') + d.toFixed(1) + ' bps since entry (' + shift + ', ' + (against ? 'against' : 'with') + ' your ' + side + ')'
})()}

**POSITION HISTORY**:
- Monitoring Checks: ${input.positionHistory.checks_count}
- Last Check: ${new Date(input.positionHistory.last_check_time).toLocaleString()}
- DCA Count: ${dcaCount}/2 (${dcasLeft === 0 ? 'MAX DCA reached — no more averaging down' : `${dcasLeft} DCA(s) remaining`})
- Trim Count: ${trimCount}/3${trimCount >= 3 ? ' — max trims reached; do NOT return action "trim" (HOLD, CUT, or FLIP only)' : ''}
${convictionTrajectory ? `- Thesis Conviction Trajectory: ${convictionTrajectory}\n` : ''}- Previous Decisions:
${input.positionHistory.previous_decisions.length === 0 ? '  • None (first monitoring check)' : input.positionHistory.previous_decisions.map(d => 
  `  • ${new Date(d.timestamp).toLocaleTimeString()}: ${d.action} (P&L: ${d.pnl_pct >= 0 ? '+' : ''}${d.pnl_pct.toFixed(2)}%${d.thesis_conviction != null ? `, conviction: ${d.thesis_conviction}` : ''})${d.engineNote ? ` [${d.engineNote}]` : ''} - ${d.reasoning}`
).join('\n')}

---

**YOUR MISSION**:

You're **losing money**. Emotion will try to cloud your judgment. You must answer ONE question:

**"If I had NO position right now, would I enter THIS trade at THIS price?"**

If YES and the red P&L is just chop (thesis intact) → HOLD, or **DCA** only when the DCA gates below are met
If MAYBE → TRIM (reduce exposure, keep probe)
If NO → CUT_LOSS (thesis invalidated, get out now)

**DECISION FRAMEWORK** (Losing Monitor Rules - PnL < 0):

**CHOP DEFENSE**:
- If volatility = **LOW** or chopRisk = **true**, default to HOLD/trim small unless a hard invalidation fires.
- Require at least **2** of the cut triggers + thesis INVALIDATED to force a full exit in chop.
- Only FLIP when trendConsistency ≥ 60% and volatility ≠ LOW. Otherwise, reassess after volatility expansion.

${isHip3Listed
    ? flowInFeed
      ? `**CUT** (Immediate cut, flip allowed) if **2/2** cut triggers OR listed-options / stored invalidation fires:
1. 🔴 **Premium Flip**: Premium flips through 0 opposite your side OR pushes further ≥ 10 bps against you
2. 🔴 **Opposite Flow Dominance**: (sell$ / buy$ ≥ 1.6 for longs; inverse for shorts). Flow Ratio N/A is NOT dominance.
- Also CUT if EQUITY/METALS OPTIONS clearly reverse the open thesis (e.g. skew flips against you) or a stored invalidation criterion fires.
- Set \`cutTriggers.oiAgainst\` = **false** always for HIP-3 (worker ignores venue OI — do not discuss OI in reason).`
      : `**CUT** (Immediate cut, flip allowed) if premium flips against you OR listed-options / stored invalidation fires:
1. 🔴 **Premium Flip**: Premium flips through 0 opposite your side OR pushes further ≥ 10 bps against you
- Also CUT if EQUITY/METALS OPTIONS clearly reverse the open thesis (e.g. skew flips against you) or a stored invalidation criterion fires.
- Set \`cutTriggers.oiAgainst\` = **false** and \`cutTriggers.oppositeFlow\` = **false**.`
    : flowInFeed
      ? `**CUT** (Immediate cut, flip allowed) if 2/3:
1. 🔴 **OI Against**: OI moves against your side by ≥ 1% over last 2 bars
2. 🔴 **Premium Flip**: Premium flips through 0 opposite your side OR pushes further ≥ 10 bps against you
3. 🔴 **Opposite Flow Dominance**: (sell$ / buy$ ≥ 1.6 for longs; inverse for shorts). Flow Ratio N/A is NOT dominance — set oppositeFlow false and metrics.flowSameSide true when taker flow is missing.`
      : `**CUT** (Immediate cut, flip allowed) if both fire:
1. 🔴 **OI Against**: OI moves against your side by ≥ 1% over last 2 bars
2. 🔴 **Premium Flip**: Premium flips through 0 opposite your side OR pushes further ≥ 10 bps against you
- Set \`cutTriggers.oppositeFlow\` = **false** and \`metrics.flowSameSide\` = **true**.`}

**TRIM** (Reduce 33-50%, keep probe) if:
- ⚠️ ${isHip3Listed ? (flowInFeed ? '1/2 cut triggers (premium/flow)' : 'premium flipped against you') : flowInFeed ? '1/3 cut triggers' : '1 of the 2 cut triggers'} met (thesis WEAKENING but not fully invalidated yet)
- ⚠️ Loss > ${(2 * hm) % 1 === 0 ? 2 * hm : (2 * hm).toFixed(1)}% but no hard invalidation signals (protect capital, keep optionality)
- ⚠️ Mixed signals: some data supports thesis, some contradicts it
- ⚠️ **MATERIAL FUNDING DRAG** deepening the hole (paid ≥ max($2, 15% of |unrealized|) AND rate against you) — soft only; never cut solely for funding
**FLIP** (if ${isHip3Listed ? (flowInFeed ? 'both cut triggers' : 'premium flip') : flowInFeed ? '3/3' : 'both cut triggers'} + strong reversal):
${isHip3Listed
    ? flowInFeed
      ? '- 🔄 Opposite flow dominance (≥ 1.6×) AND premium flipped against the old side AND listed options now favor the flip side'
      : '- 🔄 Premium flipped against the old side AND listed options now favor the flip side'
    : !flowInFeed
      ? optionsInScope
        ? '- 🔄 OI ↑ ≥ 1% AND dvol_close > dvol_open (breakout-style vol expansion) AND premium flipped against the old side'
        : '- 🔄 OI ↑ ≥ 1% AND premium flipped against the old side (dvol skipped — BTC/ETH only)'
      : optionsInScope
        ? '- 🔄 Opposite flow dominance (≥ 1.6×) AND OI ↑ ≥ 1% AND dvol_close > dvol_open (breakout-style vol expansion)'
        : '- 🔄 Opposite flow dominance (≥ 1.6×) AND OI ↑ ≥ 1% AND premium flipped against the old side (dvol skipped — BTC/ETH only)'}
- This is a rare move: thesis fully reversed, new setup emerges

**DCA** (average down — NOT the same as winning-monitor ADD) only if ALL hard gates hold AND ≥2/4 soft checklist:
Hard gates (ALL required — worker will reject if missed):
1. ✅ thesis_status = **INTACT** (original open thesis still valid; loss is timing/chop)
2. ✅ **0/${isHip3Listed ? (flowInFeed ? '2' : '1') : flowInFeed ? '3' : '2'}** cut triggers (${isHip3Listed ? (flowInFeed ? 'premiumFlip, oppositeFlow all false; oiAgainst always false' : 'premiumFlip false; oiAgainst and oppositeFlow always false') : flowInFeed ? 'oiAgainst, premiumFlip, oppositeFlow all false' : 'oiAgainst and premiumFlip false; oppositeFlow always false'})
3. ✅ Chop context: chopRisk = **true** OR volatility = **LOW**
4. ✅ Loss still has room: |price P&L%| < 50% of distance-to-stop (or < ${lossCapNoStop}% price loss if stop unknown)
5. ✅ DCA count < 2 on this position
Soft checklist (need ≥ **2/4** — cite which in reason):
1. ✅ You would STILL enter this trade at this price with no position
2. ✅ ${flowInFeed ? 'Flow still same side (not opposite dominance)' : 'Loss is still inside the original thesis, not a new opposing setup'}
3. ✅ Premium still same sign / not flipped against you
4. ✅ ${isHip3Listed ? 'Listed options still support the original side (skew / put-call not flipped against you)' : 'OI not moving against (≥ flat or continues with thesis)'}
- Size: dcaSize 0.15–0.33 of **opening** notional (default 0.25). Smaller than a winning ADD.
- Do NOT DCA to "hope" or revenge-trade. If WEAKENED/INVALIDATED → never DCA.

**HOLD** if:
- ✅ ZERO cut triggers (thesis still INTACT) but DCA hard/soft bar not met
- ✅ A single extreme liquidation on your side (≥ 90th pct) and failure to reclaim prior bar's mid → keep tiny probe only; no DCA
${isCryptoAsset(input.asset)
    ? `- ✅ **EXTENSION oversold (soft)**: EXTENSION block is oversold **and** no invalidation fired → treat the red mark as noise; do not panic-cut the low. For accumulate mandates, oversold + intact thesis is a DCA-zone hint (still subject to DCA hard gates).\n`
    : ''}
- ✅ You would STILL enter this trade right now if you had no position

**EMOTIONAL CHECK**:
You MUST self-assess your mental state:
- **RATIONAL**: "I'm analyzing data objectively, no emotions"
- **HOPEFUL**: "I'm hoping it will reverse, but data is mixed"
- **PANIC**: "I'm scared and want to exit now"

If HOPEFUL or PANIC → Your judgment is CLOUDED → Trust the data, not your gut. Prefer HOLD/TRIM/CUT over DCA.

**THESIS STATUS**:
- **INTACT**: Original signals still valid, loss is just timing/noise
- **WEAKENED**: Some signals fading but not fully invalidated
- **INVALIDATED**: Thesis is broken, must exit

**THESIS CONVICTION** (0-100 — this is NOT the same as "confidence"):
- "confidence" scores how sure you are about the ACTION you chose. "thesis_conviction" scores your CURRENT belief in the ORIGINAL entry thesis.
- Anchor to the trajectory above${openingConviction != null ? ` (opened at ${openingConviction})` : ''}: INTACT should read near opening, WEAKENED clearly below it, INVALIDATED ≤ 20.
- Be honest about drift: if the data eroded since open, the number must drop — do not restate the opening conviction out of anchoring. Equally, don't slash it just because P&L is red; conviction tracks THESIS EVIDENCE, not the mark-to-market.

**CRITICAL RULES**:
1. **If invalidation triggered → CUT_LOSS** (no exceptions)
2. **If unsure → CUT_LOSS** (preserve capital for next trade)
3. **Never hope** → Data-driven decisions only
4. **Ask yourself**: "Would I enter NOW if I had no position?"
5. **DCA is rare** — averaging down is allowed only for intact thesis + chop
6. **newStop** must be exactly "breakeven" or "tighter". A price is ignored and the stop does not move.

**OUTPUT FORMAT**:

Return a JSON object. "reason" is the technical audit trail (cite the specific
metrics and thresholds${hasEquityOptions ? '; for this HIP-3 equity, LEAD with EQUITY OPTIONS before premium/funding — omit venue OI from reason (do not write that it is N/A)' : hasMetalsOptions ? '; for this HIP-3 metal, LEAD with METALS OPTIONS (GLD/SLV) + DXY — omit venue OI from reason' : ''}).
${MONITOR_SUMMARY_FIELD_RULE}
\`\`\`json
{
  "action": "cut" | "flip" | "hold" | "trim" | "dca",
  "flipSide": "SHORT",
  "trimPct": 0.5,
  "dcaSize": 0.25,
  "newStop": "breakeven",
  "reason": "Cut. 2/3 triggers met: (1) Premium flipped from +12bps → −8bps (20bps against me, > 10bps threshold). (2) Opposite flow: sell$ / buy$ = 1.7× (meets 1.6× threshold). OI only −0.3% (doesn't meet 1% threshold, but 2/3 is enough). Thesis INVALIDATED: was long on short squeeze, but premium flip + flow reversal = squeeze failed. Loss only -0.8% but direction is wrong. Would NOT enter this LONG now. Exit immediately to preserve capital.",
  "summary": "Summary: The reason I entered this trade no longer holds — selling pressure has taken over, so I'm closing early to keep the loss small.",
  "confidence": 90,
  "metrics": {
    "oiContinues": false,
    "premiumSameSign": false,
    "flowSameSide": false
  },
  "thesis_status": "INVALIDATED",
  "thesis_conviction": 15,
  "cutTriggers": {
    "oiAgainst": false,
    "premiumFlip": true,
    "oppositeFlow": true
  },
  "emotional_check": "RATIONAL"
}
\`\`\`

**NOW DECIDE** (be ruthlessly honest).
`.trim()
}

export function validateLosingMonitorResponse(response: any): LosingMonitorOutput {
  if (!['hold', 'cut', 'flip', 'trim', 'dca'].includes(response.action)) {
    throw new Error('Invalid action. Must be hold, cut, flip, trim, or dca')
  }
  
  if (response.action === 'trim' && (!response.trimPct || response.trimPct < 0.25 || response.trimPct > 0.5)) {
    throw new Error('trimPct must be between 0.25 and 0.5 for trim actions')
  }

  if (response.action === 'dca') {
    const size = response.dcaSize ?? 0.25
    if (typeof size !== 'number' || size < 0.15 || size > 0.33) {
      throw new Error('dcaSize must be between 0.15 and 0.33 for dca actions')
    }
    response.dcaSize = size
  }

  // Lenient: conviction is advisory (audit/UI + prompt history) — clamp when
  // numeric, null it out otherwise rather than rejecting the whole decision.
  const tc = Number(response.thesis_conviction)
  response.thesis_conviction = Number.isFinite(tc)
    ? Math.min(100, Math.max(0, Math.round(tc)))
    : null

  sanitizeMonitorSummary(response)

  return response as LosingMonitorOutput
}
