import type { SessionContext } from '../session-context.js';
import { fmtUsd, renderEtfFlowsSection, type EtfFlowsContext } from '../../data/etfFlows.js';
import { renderHlPositioningSection, type HlPositioningContext } from '../../data/hlPositioning.js';
import { renderWhaleSection, type WhalePos } from '../../data/hlWhales.js';
import { HORIZON_PROFILES, normalizeHorizon, renderMonitorHorizonSection, type Horizon } from '../horizon.js';
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
import { buildLeverageRiskSection } from './leverage-risk.js';
import {
  renderFundingCarrySection,
  type FundingCarryContext,
} from './funding-carry.js';
import { MONITOR_SUMMARY_FIELD_RULE, sanitizeMonitorSummary } from './sanitizeSummary.js';

export { sanitizeMonitorSummary };

/**
 * TIER 2a: WINNING POSITION MONITOR
 *
 * Goal: Manage a winner — HOLD, ADD (pyramid), TRIM, or EXIT.
 * Context: Existing winning position, unrealized gains
 */

export interface WinningMonitorInput {
  asset: string
  position: {
    direction: 'LONG' | 'SHORT'
    entry_price: number
    current_price: number
    size: number // Position size in USD
    leverage: number
    unrealized_pnl: number // in USD
    unrealized_pnl_pct: number // % gain (PRICE move, not leveraged)
    duration_minutes: number // How long position has been open
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
    /** Opening model's stated condition for pyramiding — check this when scoring ADD. */
    add_trigger?: string | null
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
    volume_spike: boolean // Has volume spiked in last hour?
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
  equityDaily?: EquityDailyContext | null;
  /** Global sticky macro/theme board (2×/day cache). */
  stickyNarratives?: StickyNarrativesBoard | null;
  /** Per-ticker sticky catalysts (Clarity Act, partnerships, unlocks, …). */
  stickySymbolCatalysts?: StickySymbolCatalysts | null;
  /** Crypto-only stretch / exhaustion (RSI + EMA + wall-clock pctls). */
  cryptoExtension?: CryptoExtensionContext | null;
  /** Time structure — scales the loss/protect thresholds below. */
  horizon?: Horizon
  /** Allowed sides (worker-enforced; disallowed flip → cut). */
  direction?: Direction
  /** active (default) | accumulate. */
  mandate?: Mandate
  positionHistory: {
    checks_count: number // Number of monitoring checks performed
    last_check_time: string // When was last check
    has_trimmed: boolean // Whether position has been trimmed already
    trim_count: number // Number of times trimmed (should be 0, 1, 2 or 3)
    previous_decisions: Array<{
      timestamp: string
      action: string
      reasoning: string
      pnl_pct: number
      /** Thesis conviction (0-100) reported at that check; null on legacy rows. */
      thesis_conviction?: number | null
      engineNote?: string
    }> // Last 3 monitoring decisions
  }
  sessionContext: SessionContext
}

export interface WinningMonitorOutput {
  action: 'hold' | 'add' | 'trim' | 'exit'
  stopManagement?: 'move_to_breakeven' | 'tighten_stop' | 'keep_stop' // Separate from main action
  addSize?: number // 0-0.5 (if action is 'add')
  reason: string
  /** 1-2 plain-English sentences for non-technical readers (display-only). */
  summary?: string
  confidence: number // 1-100
  metrics: {
    oiContinues: boolean // OI ↑ with trend
    flowInFavor: boolean // buy$ > sell$ for longs (or inverse for shorts)
    premiumSameSign: boolean // Premium still +bps for longs (or -bps for shorts)
  }
  /** Mirror of the losing monitor's field — a winner can still have a dying thesis. */
  thesis_status: 'INTACT' | 'WEAKENED' | 'INVALIDATED' | null
  /**
   * Current belief in the ORIGINAL entry thesis (0-100), anchored to the
   * opening conviction — distinct from `confidence` (which scores the action).
   * Null when the model omitted it or returned garbage.
   */
  thesis_conviction: number | null
}

export function buildWinningMonitorPrompt(input: WinningMonitorInput): string {
  const displayAsset = coinPart(input.asset)
  const optionsInScope = supportsDeribitDvol(input.asset)
  const isEquity = assetClassOf(input.asset) === 'equity'
  const isMetals = isMetalsOptionsAsset(input.asset)
  const hasEquityOptions = isEquity && input.equityOptions != null
  const hasMetalsOptions = isMetals && input.equityOptions != null
  const hasListedOptions = hasEquityOptions || hasMetalsOptions
  const isHip3Listed = isEquity || isMetals
  const equityOptionsBlock = renderEquityOptionsSection(input.equityOptions, {
    equity: isEquity,
    metals: isMetals,
  })
  const horizon = normalizeHorizon(input.horizon)
  const hip3LiqRelevant = isHip3Listed && horizon !== 'investor'
  const baseHzp = HORIZON_PROFILES[horizon]
  // Horizon multiplier for the price-% protect thresholds (swing ×2.5) —
  // wide swing stops must not be contradicted by scalper-tight monitors.
  // Non-crypto floor at swing values: crypto-calibrated % thresholds read a
  // 0.15% equity wiggle as invalidation (observed live: TSLA trim_escalated
  // hourly at fee-level PnL).
  const hzp = isCryptoAsset(input.asset)
    ? baseHzp
    : {
        ...baseHzp,
        monitorThresholdMult: Math.max(
          baseHzp.monitorThresholdMult,
          HORIZON_PROFILES.swing.monitorThresholdMult,
        ),
        breakevenPct: Math.max(baseHzp.breakevenPct, HORIZON_PROFILES.swing.breakevenPct),
        tightenPct: Math.max(baseHzp.tightenPct, HORIZON_PROFILES.swing.tightenPct),
      }
  const hm = hzp.monitorThresholdMult
  const pctT = (base: number) => `${(base * hm) % 1 === 0 ? base * hm : (base * hm).toFixed(1)}%`
  const horizonSection = renderMonitorHorizonSection(horizon)
  const mandateSection = renderMonitorMandateSection(
    normalizeDirection(input.direction),
    normalizeMandate(input.mandate),
  )
  const timeHeld = (input.position.duration_minutes / 60).toFixed(1)
  const hasOriginalTP = typeof input.original.take_profit === 'number' && Number.isFinite(input.original.take_profit) && input.original.take_profit > 0
  const originalTPValue = hasOriginalTP ? input.original.take_profit : null
  const distanceToTP = originalTPValue
    ? (input.position.direction === 'SHORT'
        ? ((input.position.current_price - originalTPValue) / input.position.current_price * 100)
        : ((originalTPValue - input.position.current_price) / input.position.current_price * 100)
      ).toFixed(2)
    : 'N/A'
  const takeProfitText = originalTPValue
    ? `$${originalTPValue.toLocaleString()}`
    : 'N/A (not recorded)'
  const hasOriginalStop = typeof input.original.stop_loss === 'number' && Number.isFinite(input.original.stop_loss) && input.original.stop_loss > 0
  const stopLossText = hasOriginalStop
    ? `$${input.original.stop_loss.toLocaleString()}`
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
  const addTriggerText =
    typeof input.original.add_trigger === 'string' && input.original.add_trigger.trim()
      ? input.original.add_trigger.trim()
      : null
  const regime = input.updatedData.regime
  const regimeSection = regime
    ? `

**REGIME CONTEXT**:
- Volatility: **${regime.volatilityState.toUpperCase()}**${regime.volatilityState === 'low' ? ' (compression)' : regime.volatilityState === 'high' ? ' (expansion)' : ''}
- Liquidity: **${regime.liquidityState.toUpperCase()}**
- Trend Consistency: ${(regime.trendConsistency * 100).toFixed(0)}%
- Chop Risk: ${regime.chopRisk ? '⚠️ ACTIVE — default to patience, protect gains' : 'No'}
- Range Compression: ${regime.rangeCompression ? 'Yes (tight ranges, expect fake-outs)' : 'No'}`
    : ''
  const session = input.sessionContext
  const sessionSection = session
    ? `

**SESSION CONTEXT**:
- Session: **${session.label.toUpperCase()}** (${session.sessionWindowUTC})
- US Session Active: ${session.isUsSession ? 'Yes (full liquidity)' : 'No — expect thinner liquidity'}
- Thin hours (Fri 19:00–Sun 21:00 UTC): ${session.isWeekend ? '⚠️ YES — size/trim decisions should stay conservative' : 'No'}`
    : ''
  const riskSection = buildLeverageRiskSection(input.position)
  const fundingCtx: FundingCarryContext = {
    marketFundingBps: input.updatedData.funding_rate_bps,
    marketFundingChangeBps: input.updatedData.funding_rate_change_bps,
    hlNextFundingBps: input.updatedData.hl_next_funding_bps,
    fundingPnlUsd: input.updatedData.funding_pnl_usd,
    unrealizedPnlUsd: input.position.unrealized_pnl,
    direction: input.position.direction,
  }
  const fundingSection = renderFundingCarrySection(fundingCtx)
  
  return `
You are monitoring a **WINNING ${input.position.direction}** position on ${displayAsset}.

**POSITION STATUS**:
- Direction: **${input.position.direction}**
- Entry: $${input.position.entry_price.toLocaleString()}
- Current: $${input.position.current_price.toLocaleString()} ${input.position.direction === 'LONG' ? '📈' : '📉'}
- Unrealized P&L: **+${input.position.unrealized_pnl_pct.toFixed(2)}%** price move (+$${input.position.unrealized_pnl.toFixed(2)})
- Time Held: ${timeHeld} hours
${riskSection}

**ORIGINAL THESIS**:
- Conviction: ${convictionText}
- Entry Reasoning: ${input.original.reasoning?.trim() ? `"${input.original.reasoning.trim()}"` : 'N/A (not recorded)'}
- Add Trigger (from entry): ${addTriggerText ? `"${addTriggerText}"` : 'N/A (not recorded) — still evaluate the ADD checklist below'}
- Stop-Loss: ${stopLossText}
- Take-Profit: ${takeProfitText}${distanceToTP !== 'N/A' ? ` (${distanceToTP}% away)` : ''}
- Invalidation Criteria: ${input.original.invalidation_criteria.length ? input.original.invalidation_criteria.join('; ') : 'None recorded'}

**UPDATED MARKET DATA**:
- Spot Price: $${input.updatedData.spot_price.toLocaleString()}
${!isHip3Listed
    ? `- Liquidations (last 1h bar): ${input.updatedData.liquidations_1h ? `Longs: $${(input.updatedData.liquidations_1h.longs / 1e6).toFixed(2)}M, Shorts: $${(input.updatedData.liquidations_1h.shorts / 1e6).toFixed(2)}M` : 'N/A (no liquidation data for this symbol)'}\n`
    : hip3LiqRelevant
      ? `- Venue liquidations (last 1h, HL/tradeXYZ leverage map — squeeze/cascade fuel only, not thesis): ${input.updatedData.liquidations_1h ? `Longs flushed: $${(input.updatedData.liquidations_1h.longs / 1e6).toFixed(2)}M, Shorts flushed: $${(input.updatedData.liquidations_1h.shorts / 1e6).toFixed(2)}M` : 'N/A'}\n`
      : `- Venue liquidations: ignore for investor thesis (noise unless YOUR liquidation distance is threatened)\n`}
${optionsInScope
    ? `- IV Change since entry: ${input.updatedData.iv_change != null ? `${input.updatedData.iv_change > 0 ? '+' : ''}${input.updatedData.iv_change.toFixed(2)} pts (${input.updatedData.iv_change > 3 ? 'FEAR RISING' : input.updatedData.iv_change < -3 ? 'FEAR DROPPING' : 'NEUTRAL'})` : 'N/A (entry predates the IV window)'}`
    : hasEquityOptions
      ? `- Options: listed US equity options are PRIMARY for ${displayAsset} — see EQUITY OPTIONS next (omit thin venue OI from reason)`
      : hasMetalsOptions
        ? `- Options: GLD/SLV metals options + DXY are PRIMARY for ${displayAsset} — see METALS OPTIONS next (omit thin venue OI; no corporate earnings)`
        : `- Options/IV: out of scope for ${displayAsset} (Deribit DVOL is BTC/ETH only — not a feed outage)`}
- Volume Spike: ${input.updatedData.volume_spike ? '⚠️ YES (potential reversal or continuation)' : 'No'}
${hasListedOptions ? equityOptionsBlock : ''}
${regimeSection}
${sessionSection}${renderXyzSessionSection(getXyzSessionContext(input.asset))}${renderCalendarSection(input.sessionContext?.upcomingEvents, undefined, { forEquity: isEquity || isMetals })}${renderStickyNarrativesSection(input.stickyNarratives)}${renderStickySymbolCatalystsSection(input.stickySymbolCatalysts)}${input.equityDaily ? renderEquityDailySection(input.equityDaily) : renderEmaSection(input.ema, { hip3: !isCryptoAsset(input.asset) })}${renderEarningsSection(input.earnings, { equity: isEquity })}${hasListedOptions ? '' : equityOptionsBlock}${isCryptoAsset(input.asset) ? renderEtfFlowsSection(input.etfFlows) : ''}${isCryptoAsset(input.asset) ? renderHlPositioningSection(input.hlPositioning) : ''}${isCryptoAsset(input.asset) ? renderCryptoExtensionSection(input.cryptoExtension) : ''}${renderWhaleSection(input.whalePositions, input.asset, input.position.current_price)}${horizonSection}${mandateSection}

${fundingSection}
**DETAILED MARKET ANALYSIS** (for user transparency):
- **Flow Dynamics**: Current flow ratio shows ${input.updatedData.flowRatio != null && Number.isFinite(input.updatedData.flowRatio) ? `${input.updatedData.flowRatio.toFixed(2)} (${input.updatedData.flowRatio > 1.2 ? 'BUY DOMINANT' : input.updatedData.flowRatio < 0.8 ? 'SELL DOMINANT' : 'BALANCED'})` : 'N/A (unavailable — not a balanced tape)'}
${!isHip3Listed
    ? `- **Flow Path (CVD, 24-bar)**: futures ${input.updatedData.cvdNet24Usd != null ? fmtUsd(input.updatedData.cvdNet24Usd) : 'N/A'}, spot ${input.updatedData.spotCvdNet24Usd != null ? fmtUsd(input.updatedData.spotCvdNet24Usd) : 'N/A'} | divergence: ${input.updatedData.cvdDivergence === 'bearish' ? 'BEARISH (buyers absorbed — upside fragile)' : input.updatedData.cvdDivergence === 'bullish' ? 'BULLISH (sellers absorbed — downside fragile)' : input.updatedData.cvdDivergence === 'none' ? 'none' : 'N/A'}\n`
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
      ? `- **Venue liq pressure**: ${input.updatedData.liquidations_1h ? `${input.updatedData.liquidations_1h.longs > input.updatedData.liquidations_1h.shorts ? 'longs flushed' : 'shorts flushed'} last bar — local HL fuel only` : 'N/A'}\n`
      : ''}

**POSITION HISTORY**:
- Monitoring Checks: ${input.positionHistory.checks_count}
- Last Check: ${new Date(input.positionHistory.last_check_time).toLocaleString()}
- **Already Trimmed**: ${input.positionHistory.trim_count >= 3 ? '✅ YES (max 3 trims reached — TRIM unavailable; choose HOLD / ADD / EXIT only)' : `❌ NO (${3 - (input.positionHistory.trim_count || 0)} trims remaining)`}
- Trim Count: ${input.positionHistory.trim_count || 0}/3 (max 3 trims per position)${input.positionHistory.trim_count >= 3 ? ' — do NOT return action "trim"' : ''}
${convictionTrajectory ? `- Thesis Conviction Trajectory: ${convictionTrajectory}\n` : ''}- Previous Decisions:
${input.positionHistory.previous_decisions.length === 0 ? '  • None (first monitoring check)' : input.positionHistory.previous_decisions.map(d => 
  `  • ${new Date(d.timestamp).toLocaleTimeString()}: ${d.action} (P&L: ${d.pnl_pct >= 0 ? '+' : ''}${d.pnl_pct.toFixed(2)}%${d.thesis_conviction != null ? `, conviction: ${d.thesis_conviction}` : ''})${d.engineNote ? ` [${d.engineNote}]` : ''} - ${d.reasoning}`
).join('\n')}

**P&L MOMENTUM ANALYSIS**:
${input.positionHistory.previous_decisions.length >= 1 ? (() => {
  const prev = input.positionHistory.previous_decisions[input.positionHistory.previous_decisions.length - 1]!
  const pnlChange = input.position.unrealized_pnl_pct - prev.pnl_pct
  const isDeclining = pnlChange < -1.0 * hm; // Significant profit drop (horizon-scaled)
  const isAccelerating = pnlChange > 1.0 * hm; // Profit accelerating
  return `- P&L Change since last check: ${pnlChange >= 0 ? '+' : ''}${pnlChange.toFixed(2)}% (${isDeclining ? '⚠️ DECLINING PROFIT' : isAccelerating ? '📈 ACCELERATING' : '📊 STABLE'})
- Current: ${input.position.unrealized_pnl_pct.toFixed(2)}% vs last check: ${prev.pnl_pct.toFixed(2)}%
${isDeclining ? '🚨 PROFIT PROTECTION NEEDED: Consider TRIM or tighter stop!' : ''}`;
})() : '  • Insufficient history for momentum analysis'}

---

**YOUR MISSION**:

You're **in profit**. All four actions are first-class — do not treat this as "trim/exit only":
1. **HOLD**: Let it run toward take-profit (NO size change; stop changes via stopManagement)
2. **ADD**: Pyramid into strength when the ADD bar is met (grow the winner)
3. **TRIM**: Take partial profit (25-33%) when protection signals fire
4. **EXIT**: Fully close and lock gains when hard exit signals fire

When you HOLD, say briefly whether ADD was close/met/not-met (users need to see that pyramiding was considered). Prefer ADD over idle HOLD when ≥3/4 ADD conditions fire and chop defense allows it.

**DECISION FRAMEWORK** (Winning Monitor Rules - PnL > 0):

**CHOP DEFENSE**:
- If volatility = **LOW** or chopRisk = **true**, default to HOLD unless ≥ 2 hard signals fire.
- Only ADD when trendConsistency ≥ 70% **and** ${isHip3Listed ? 'listed options + premium/flow confirm the trend (venue OI ignored)' : 'flow/OI/premium all confirm the trend'}.
- Prefer tightening stops / moving to breakeven instead of trimming in chop. Protect gains first.

**ADD** (pyramid lightly, ≤ +0.5× **opening** notional — trims do not shrink the add base) if 3/4 fire:
1. ✅ Price makes higher high (long) / lower low (short)
${isHip3Listed
    ? '2. ✅ Listed options still support your side (skew / put-call not flipped against you)'
    : '2. ✅ OI continues ↑ ≥ 0.5% vs last add'}
3. ✅ Premium drifts further in your favor by ≥ 5 bps
4. ✅ ${isHip3Listed ? 'Venue flow still in favor (brief FR) — spot CVD not required on HIP-3' : 'Spot flow CONFIRMS (spot CVD net delta same sign as your side — real demand, not perp-only leverage)'}
${addTriggerText
    ? `- Also honor the entry **Add Trigger** when it is clearly satisfied (treat as strong support for ADD alongside the checklist).`
    : ''}

**TRIM** (take partial 25–33%, MAX THREE TIMES per position) if 2/4:
1. ⚠️ **PROFIT DECLINING**: P&L dropped > ${pctT(1.5)} since last check (protect gains!)
2. ⚠️ **MATERIAL FUNDING DRAG**: accrued funding cost ≥ max($2, 15% of |unrealized|) AND market/HL funding still against your side (rate alone does NOT count)
${optionsInScope
    ? '3. ⚠️ dvol_close spikes above dvol_open by ≥ 3 vol pts'
    : hasListedOptions
      ? '3. ⚠️ Listed options turn against you (skew / put-call flip) OR opposite venue flow intensifies (≥ 1.5×)'
      : '3. ⚠️ Opposite flow intensifies (≥ 1.5× against you) — dvol skipped (BTC/ETH only)'}
4. ⚠️ ${hip3LiqRelevant ? 'Opposite-side venue liquidation cluster without reclaim (local HL fuel — soft only)' : isHip3Listed ? 'Skip venue-liq trim trigger on investor horizon' : 'Opposite-side liquidations cluster (2+ bars ≥ 85th pct) without reclaim of prior high/low'}
${isCryptoAsset(input.asset)
    ? `5. ⚠️ **EXTENSION / EUPHORIA (soft)**: EXTENSION block is stretched **and** (funding crowded on your side **or** thesis_status = WEAKENED). Do **not** trim solely on high RSI while thesis is INTACT and trend is still expanding.\n`
    : ''}⚠️ **TRIM LIMIT**: Can ONLY trim THRICE. After third trim, ONLY hold/add/exit allowed

**EXIT** (hard exit signal) if:
1. 🔴 **MAJOR PROFIT LOSS**: P&L dropped > ${pctT(3)} since last check (emergency exit!)
2. 🔴 ${isHip3Listed ? 'Premium crosses 0 against you AND listed options flip against your side (venue OI ignored)' : 'Premium crosses 0 against you AND OI flips against direction (OI ↓ on long trend; OI ↑ on short trend)'}
3. 🔴 Two bars in a row with opposite flow: (sell$ ≥ 1.5× buy$ for longs; inverse for shorts)
⚠️ Funding is **never** a hard EXIT trigger by itself.

**HOLD** (default) if:
- ✅ Trend conditions persist: ${isHip3Listed ? 'options still support side, flow in favor, premium same sign' : 'OI ↑ with trend, flow in favor, premium same sign'}
- ✅ ADD bar not met (< 3/4 add conditions, or chop defense blocks pyramiding)
- ✅ No trim/exit signals are present (< 2/4 trim triggers)
- ✅ Already trimmed three times (can't trim again, only hold, add or exit)

**STOP MANAGEMENT** (separate from main decision):
- **MOVE_TO_BREAKEVEN**: If P&L > ${hzp.breakevenPct}% and stop is still below entry
- **TIGHTEN_STOP**: If P&L > ${hzp.tightenPct}% and stop is more than ${hm > 1 ? 2 : 1}% away from current price
- **KEEP_STOP**: If stop is already optimal (close to breakeven or trailing)

**EXAMPLES** (thresholds already horizon-scaled):
- **Scenario 1**: P&L was +${(4.6 * hm).toFixed(1)}% → now +${(1.3 * hm).toFixed(1)}% (dropped beyond the ${pctT(1.5)} trim trigger) = **TRIM 25-33%** (protect gains!)
- **Scenario 2**: P&L was +${(2.0 * hm).toFixed(1)}% → now ${(-0.5 * hm).toFixed(1)}% (dropped beyond the ${pctT(3)} exit trigger) = **EXIT** (emergency!)
- **Scenario 3**: P&L was +${(1.0 * hm).toFixed(1)}% → now +${(2.5 * hm).toFixed(1)}%, ${isHip3Listed ? 'options still support side, ' : 'OI ↑, '}premium drifts +6bps, flow in favor = **ADD** (pyramid the winner)
- **Scenario 4**: P&L rising but only 1–2/4 ADD conditions and no trim/exit = **HOLD** (let it run; mention ADD not met)

**GREED vs DISCIPLINE**:
- You're ALLOWED to be greedy if thesis is strong AND profit is stable/rising — that includes ADD when the bar is met
- You're REQUIRED to be disciplined if profit is declining (protect what you have!)

**THESIS & CONVICTION CHECK** (a winner can still have a dying thesis):
- thesis_status: judge the ORIGINAL entry thesis against the updated data — **INTACT** (still driving the move), **WEAKENED** (driver fading or target mostly realized), **INVALIDATED** (move happened for other reasons / driver reversed).
- thesis_conviction (0-100 — NOT the same as "confidence"): your CURRENT belief in the original thesis. Anchor to the trajectory above${openingConviction != null ? ` (opened at ${openingConviction})` : ''}; conviction tracks THESIS EVIDENCE, not the green P&L — don't inflate it just because the position is up.
- **Worker-enforced**: if thesis is WEAKENED (or conviction decayed ≥ 25 pts below opening — or below 40 for positions that OPENED at 40+) while in profit, an idle HOLD/ADD is upgraded to TRIM; if INVALIDATED, HOLD/ADD is upgraded to EXIT. Prefer returning TRIM/EXIT yourself when those conditions hold — don't wait for the worker. A probe that opened below 40 is NOT auto-trimmed just for still being a probe — judge its thesis on evidence. Hard checklists still guide size/timing; they do not excuse parking a dying thesis.

**OUTPUT FORMAT**:

Return a JSON object. "reason" is the technical audit trail (cite the specific
metrics and thresholds${hasEquityOptions ? '; for this HIP-3 equity, LEAD with EQUITY OPTIONS before premium/funding — omit venue OI from reason (do not write that it is N/A)' : hasMetalsOptions ? '; for this HIP-3 metal, LEAD with METALS OPTIONS (GLD/SLV) + DXY before premium — omit venue OI from reason' : ''}).
${MONITOR_SUMMARY_FIELD_RULE}
\`\`\`json
{
  "action": "hold" | "add" | "trim" | "exit",
  "stopManagement": "move_to_breakeven" | "tighten_stop" | "keep_stop",
  "addSize": 0.3,
  "reason": "Add 0.3× base. 3/4 conditions met: (1) Price made higher high ($95k → $95.5k). (2) OI ↑ +0.7% since last check (meets 0.5% threshold). (3) Premium drifted from +12bps → +17bps (+5bps in favor). (4) Spot CVD net +$3.1M confirms real demand. Flow continues buy-dominant (1.4×). No trim signals: funding accrued −$0.40 (≪ 15% of +$85 unrealized — ignore), IV stable (+0.5pts < 3pt threshold). Trend persists, add to winner.",
  "summary": "Summary: The trade keeps working — price is pushing to new highs and real buying demand is still coming in, so I'm adding a little while keeping the stop in place.",
  "confidence": 85,
  "metrics": {
    "oiContinues": true,
    "flowInFavor": true,
    "premiumSameSign": true
  },
  "thesis_status": "INTACT",
  "thesis_conviction": 72
}
\`\`\`

**PROFIT TARGET STATUS**:
- **ON_TRACK**: Price moving toward take-profit, no major obstacles
- **EXCEEDED**: Already hit or exceeded take-profit target
- **STALLING**: Price consolidating, momentum fading

**RISK ASSESSMENT**:
- **LOW**: Thesis strong, momentum with you, no red flags
- **MEDIUM**: Some warning signs (material funding drag, volume spike) but not critical
- **HIGH**: Strong reversal signals (invalidation criteria triggered, momentum dead)
**CRITICAL RULES**:
- Be HONEST about greed vs logic
- If unsure, MOVE_STOP (protect gains, keep position open)
- If risk is HIGH, CLOSE_NOW (profit is profit)

**NOW DECIDE**.
`.trim()
}

export function validateWinningMonitorResponse(response: any): WinningMonitorOutput {
  if (!['hold', 'add', 'trim', 'exit'].includes(response.action)) {
    throw new Error('Invalid action. Must be hold, add, trim, or exit')
  }
  
  if (response.stopManagement && !['move_to_breakeven', 'tighten_stop', 'keep_stop'].includes(response.stopManagement)) {
    throw new Error('Invalid stopManagement. Must be move_to_breakeven, tighten_stop, or keep_stop')
  }

  // Lenient: thesis fields are advisory (audit/UI + prompt history) — normalize
  // when malformed rather than rejecting the whole decision.
  if (!['INTACT', 'WEAKENED', 'INVALIDATED'].includes(response.thesis_status)) {
    response.thesis_status = null
  }
  const tc = Number(response.thesis_conviction)
  response.thesis_conviction = Number.isFinite(tc)
    ? Math.min(100, Math.max(0, Math.round(tc)))
    : null

  sanitizeMonitorSummary(response)

  return response as WinningMonitorOutput
}

