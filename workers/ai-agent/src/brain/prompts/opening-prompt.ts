/**
 * TIER 1: OPENING DECISION PROMPT (invoked on demand; no fixed schedule)
 * Uses computeScalperFlags to analyze CoinGlass 1h series.
 * No technical indicators - pure microstructure (OI, flow, premium, liqs, IV).
 * Gamma was excised 2026-07: Deribit gives us DVOL only, gamma_dollars was
 * never populated — rendering it was fake precision the models had to ignore.
 */

import type { ScalperFlags, CompositeScore } from '../computeScalperFlags.js';
import type { StopPlan } from '../computeStops.js';
import type { SessionContext } from '../session-context.js';
import {
  HORIZON_PROFILES,
  normalizeHorizon,
  renderOpeningHorizonSection,
  type Horizon,
} from '../horizon.js';
import {
  normalizeDirection,
  normalizeMandate,
  renderOpeningMandateSection,
  type Direction,
  type Mandate,
} from '../mandate.js';
import {
  earningsConvictionGate,
  openingConvictionGate,
  openingProbeFloor,
  type RiskProfile,
} from '../riskProfile.js';
import { fmtUsd, renderEtfFlowsSection, type EtfFlowsContext } from '../../data/etfFlows.js';
import { renderHlPositioningSection, type HlPositioningContext } from '../../data/hlPositioning.js';
import { renderWhaleSection, type WhalePos } from '../../data/hlWhales.js';
import { renderCalendarSection } from '../../data/macroCalendar.js';
import { renderMarketMoodSection, type MarketMoodContext } from '../../data/marketMood.js';
import {
  renderStickyNarrativesSection,
  type StickyNarrativesBoard,
} from '../../data/stickyNarratives.js';
import {
  renderStickySymbolCatalystsSection,
  type StickySymbolCatalysts,
} from '../../data/stickySymbolCatalysts.js';
import {
  renderLastSymbolCloseSection,
  type LastSymbolClose,
} from '../../stores.js';
import { renderOptionsPositioningSection, type OptionsPositioningContext } from '../../data/optionsPositioning.js';
import {
  renderEmaSection,
  renderMacroBetaSection,
  type EmaContext,
  type MacroBetaContext,
} from '../../data/emaList.js';
import {
  renderCryptoExtensionOpeningRules,
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
import { supportsDeribitDvol } from '../../data/deribit.js';
import { renderBookSection, type BookSnapshot } from '../../hl/bookSnapshot.js';
import { sanitizeMonitorSummary, stripHip3DexPrefix } from './sanitizeSummary.js';
import {
  assetClassOf,
  classLabel,
  coinPart,
  isCryptoAsset,
  isHip3Symbol,
} from '../assetClass.js';

export interface OpeningPromptInput {
  asset: string;
  flags: ScalperFlags;
  score: CompositeScore;
  currentPrice: number;
  /** Session-range stop/TP anchors for both sides (advisory, leverage-neutral). */
  stopAnchors?: { long: StopPlan; short: StopPlan } | null;
  /** Daily spot-ETF flow context (BTC/ETH/SOL/XRP only, else null). */
  etfFlows?: EtfFlowsContext | null;
  /** Platform-wide HL cohort positioning (globally cached). Crypto only. */
  hlPositioning?: HlPositioningContext | null;
  /** Fear&Greed + stablecoin mcap one-liners (opening only). Crypto only. */
  marketMood?: MarketMoodContext | null;
  /** Global sticky macro/theme board (2×/day cache). */
  stickyNarratives?: StickyNarrativesBoard | null;
  /** Per-ticker sticky catalysts (Clarity Act, partnerships, unlocks, …). */
  stickySymbolCatalysts?: StickySymbolCatalysts | null;
  /** Most recent close on this symbol (within horizon reopen window). */
  lastSymbolClose?: LastSymbolClose | null;
  /** HL $1M+ whale positions — per-symbol bias + liq clusters. */
  whalePositions?: WhalePos[] | null;
  /** Options positioning (ΔOI, vol/OI, premium PCR) — BTC/ETH only. */
  optionsPositioning?: OptionsPositioningContext | null;
  /** Live EMA stack — HIP-3 preferred. */
  ema?: EmaContext | null;
  /** Next earnings — equity HIP-3. */
  earnings?: EarningsContext | null;
  /** Listed US options chain metrics (Massive) — equity HIP-3. */
  equityOptions?: EquityOptionsContext | null;
  /** Real US daily-bar trend context (Massive aggs) — equity/metals HIP-3. */
  equityDaily?: EquityDailyContext | null;
  /** SP500 + DXY beta one-liners for HIP-3. */
  macroBeta?: MacroBetaContext | null;
  /** Crypto-only stretch / exhaustion (RSI + EMA + wall-clock pctls). */
  cryptoExtension?: CryptoExtensionContext | null;
  /** Live HL L2 snapshot (spread / imbalance / depth) — execution context. */
  book?: BookSnapshot | null;
  /** Entry appetite — changes gates + guard language, never size bands. */
  riskProfile?: RiskProfile;
  /** Time structure — flag windows, stop anchors, TP floor (brain/horizon.ts). */
  horizon?: Horizon;
  /** Allowed sides (worker-enforced) — see brain/mandate.ts. */
  direction?: Direction;
  /** What success means — active (default) | accumulate. */
  mandate?: Mandate;
  /** Bar size of the fetched series (crypto scalpers: 30m). Display only. */
  barIntervalLabel?: '1h' | '30m';
  sessionContext: SessionContext;
}

export interface OpeningPromptOutput {
  decision: 'LONG' | 'SHORT' | 'FLAT';
  conviction: number; // 0-100
  size: number; // 0.2-0.8 (fraction of base position)
  entry_price: number;
  stop_price: number; // Absolute price level
  take_profit_target: number; // Absolute price level (TP1)
  R: number; // Stop distance in price terms
  addTrigger?: string;
  /** Concrete, checkable conditions that would invalidate this trade (fed to the losing monitor). */
  invalidation_criteria?: string[];
  key_metrics: {
    oiDeltaPct: number | null;
    flowRatio: number | null;
    premiumBps: number | null;
    ivDelta: number | null;
  };
  reasoning: string;
  /** 1-2 plain-English sentences for non-technical readers (display-only). */
  summary?: string;
}

export function buildOpeningPrompt(input: OpeningPromptInput): string {
  const { asset, flags, score, currentPrice, stopAnchors, sessionContext } = input;
  // Prose / examples use the underlier ticker (TSLA). Keep full HL coin
  // (XYZ:TSLA) only for venue lookups — users shouldn't see DEX prefixes.
  const displayAsset = coinPart(asset);
  const riskProfile: RiskProfile = input.riskProfile === 'aggressive' ? 'aggressive' : 'standard';
  /** Internal appetite flag — never spell product labels (aggressive/standard) in the prompt. */
  const activeEntry = riskProfile === 'aggressive';
  const crypto = isCryptoAsset(asset);
  const hip3 = isHip3Symbol(asset);
  const aClass = assetClassOf(asset);
  const xyzSession = hip3 ? getXyzSessionContext(asset) : null;
  const thinHours = crypto ? sessionContext.isWeekend : xyzSession?.pricingMode !== 'external';
  const horizon = normalizeHorizon(input.horizon);
  const hp = HORIZON_PROFILES[horizon];
  const horizonBlock = renderOpeningHorizonSection(horizon);
  const mandateBlock = renderOpeningMandateSection(
    normalizeDirection(input.direction),
    normalizeMandate(input.mandate),
  );
  const isEquityAsset = aClass === 'equity';
  const isMetalsAsset = isMetalsOptionsAsset(asset);
  // Crypto-only blocks — never inject BTC ETF / Deribit / fear-greed onto HIP-3.
  const etfBlock = crypto ? renderEtfFlowsSection(input.etfFlows) : '';
  const positioningBlock = crypto
    ? renderHlPositioningSection(input.hlPositioning)
    : '';
  const moodBlock = crypto ? renderMarketMoodSection(input.marketMood) : '';
  const extensionBlock = crypto ? renderCryptoExtensionSection(input.cryptoExtension) : '';
  const extensionRules = crypto
    ? renderCryptoExtensionOpeningRules(input.cryptoExtension)
    : '';
  const stickyBlock = renderStickyNarrativesSection(input.stickyNarratives);
  // Live L2 read — sizes/patience only; the block itself says it is not a thesis.
  const bookBlock = renderBookSection(input.book);
  const tickerCatalystBlock = renderStickySymbolCatalystsSection(input.stickySymbolCatalysts);
  const lastCloseBlock = renderLastSymbolCloseSection(input.lastSymbolClose);
  // Whales: venue $1M+ on THIS symbol only (renderWhaleSection no-ops if none).
  const whaleBlock = renderWhaleSection(input.whalePositions, asset, currentPrice);
  const optionsPositioningBlock = crypto
    ? renderOptionsPositioningSection(input.optionsPositioning)
    : '';
  const emaBlock = renderEmaSection(input.ema, { hip3 });
  // Real daily closes (Massive) — equity/metals only; renders '' otherwise.
  const dailyBlock = renderEquityDailySection(input.equityDaily);
  const earningsBlock = renderEarningsSection(input.earnings, {
    equity: isEquityAsset,
  });
  const equityOptionsBlock = renderEquityOptionsSection(input.equityOptions, {
    equity: isEquityAsset,
    metals: isMetalsAsset,
  });
  const betaBlock = renderMacroBetaSection(input.macroBeta, { forHip3: hip3 });
  const xyzSessionBlock = renderXyzSessionSection(xyzSession);
  // Same US macro allowlist (FOMC/CPI/…) — stocks + metals both care.
  const calendarBlock = renderCalendarSection(sessionContext?.upcomingEvents, undefined, {
    aggressive: activeEntry,
    forEquity: isEquityAsset || isMetalsAsset,
  });
  const optionsInScope = supportsDeribitDvol(asset);
  const earningsGateFloor = earningsConvictionGate(riskProfile);
  const earningsGate =
    input.earnings?.within48h
      ? `
- **EARNINGS WINDOW** (worker-enforced): next report ${input.earnings.nextDate} (≤48h). Fresh opens with conviction < ${earningsGateFloor} are REJECTED by the engine — return FLAT instead; if you do trade at ≥ ${earningsGateFloor}, size at the low end of the band and widen stops for gap risk.`
      : '';
  // Swing/investor entries against the trend stack are rejected below
  // conviction 50 (worker-enforced). Equity/metals prefer the REAL daily
  // stack (Massive closes) over perp-venue EMAs; scalper is exempt.
  const trendStack =
    input.equityDaily?.stack === 'bullish' || input.equityDaily?.stack === 'bearish'
      ? input.equityDaily.stack
      : input.ema?.stack ?? null;
  const trendStackSrc = input.equityDaily?.stack === trendStack ? 'daily 20/50/200d' : '1d/1w EMA';
  const emaStackDir =
    trendStack === 'bullish' ? 'LONG' : trendStack === 'bearish' ? 'SHORT' : null;
  const trendGate =
    horizon !== 'scalper' && emaStackDir
      ? `
- **TREND FILTER** (worker-enforced): the ${trendStackSrc} stack is ${trendStack!.toUpperCase()}. Counter-trend entries (${emaStackDir === 'LONG' ? 'SHORT' : 'LONG'}) with conviction < 50 are REJECTED by the engine — go with the stack, or bring ≥ 50 conviction and cite what overrides it.`
      : '';
  // Horizon floor stacked on the risk-profile gate — MUST mirror the worker
  // (considerOpening) so prompt text and enforcement can't drift.
  const minConviction = Math.max(
    openingConvictionGate(thinHours, riskProfile),
    hp.minConvictionGate ?? 0,
  );
  const probeBandLabel = `${minConviction}-44`;
  /** Exploratory tier just under the gate. Disabled (== gate) for investor. */
  const probeFloor = hp.allowProbes ? openingProbeFloor(minConviction) : minConviction;
  const probesEnabled = probeFloor < minConviction;

  // Prompt-facing: thin hours vs active entry. Do not say aggressive/standard —
  // users never pick those labels in the wizard.
  const profileBlock = thinHours
    ? `

**THIN HOURS** (Fri 19:00 UTC → Sun 21:00 UTC):
- Liquidity and institutional flow are reduced. Prefer patience; skip ambiguous
  bars freely. When you do trade, keep size at the low end of the band.
- Quiet tape can still resolve into trends — but the bar to open is higher.`
    : activeEntry
      ? `

**ENTRY APPETITE** (default):
- Sidelining every ambiguous bar is a failure mode. When one side is even
  mildly better, prefer a probe or small position over FLAT.
- Guards below modulate SIZE first — they are not standing instructions to
  stay out. Quiet sessions can still resolve into trends; small-and-early
  is preferred over endless FLAT.
- Risk discipline is unchanged: size bands, stops, and take-profits stay the
  same. More positions when there is edge — not bigger ones.`
      : `

**ENTRY APPETITE** (patient):
- Skip ambiguous bars freely. Prefer FLAT unless signals clearly align.`;
  const sessionBlock = crypto && sessionContext
    ? `

**SESSION CONTEXT**:
- Session: ${sessionContext.label} (${sessionContext.sessionWindowUTC})
- US Session Active: ${sessionContext.isUsSession ? 'YES' : 'NO — expect thinner institutional flow'}
- Thin hours: ${thinHours ? 'YES — Fri 19:00–Sun 21:00 UTC; reduced liquidity, favor patience / min size' : 'No'}
`
    : '';

  const holdPhrase =
    horizon === 'investor'
      ? 'multi-week to month+ holds'
      : horizon === 'swing'
        ? 'multi-day swings'
        : 'multi-hour moves';
  const persona = hip3
    ? isMetalsAsset
      ? `You are a professional trader on Hyperliquid HIP-3 (tradeXYZ), trading a tokenized ${classLabel(aClass)} perpetual (gold/silver). Lead with GLD/SLV listed-options flow + DXY (MACRO BETA) + metal EMAs; HL venue OI is NOT a thesis signal. Venue liquidation clusters matter only as short-horizon squeeze/cascade fuel (scalper/swing). No corporate earnings. Not crypto Fear&Greed, not tick scalps.`
      : `You are a professional trader on Hyperliquid HIP-3 (tradeXYZ), trading a tokenized ${classLabel(aClass)} perpetual. Price anchors to the underlying during external sessions and floats inside discovery bounds off-session. Lead with listed options + daily structure + macro; do NOT treat venue OI as positioning/narrative. Venue liquidation clusters are local leverage fuel for scalper/swing — not global options liquidations. Not crypto Fear&Greed, not tick scalps.`
    : `You are a professional crypto perp trader on Hyperliquid, trading ${holdPhrase} from ${input.barIntervalLabel ?? '1h'}-bar microstructure (flow, OI, premium, liquidations, options) — not tick scalps, not buy-and-hold.`;

  const fmt = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const anchorsBlock = stopAnchors ? `

**RISK ANCHORS** (session-range based; anchor your stop near these — deviate only with a cited reason):
- If LONG: stop ≈ ${fmt(stopAnchors.long.stopPrice)} (R ≈ ${fmt(stopAnchors.long.R)}, ${((stopAnchors.long.R / currentPrice) * 100).toFixed(2)}% of price)
- If SHORT: stop ≈ ${fmt(stopAnchors.short.stopPrice)} (R ≈ ${fmt(stopAnchors.short.R)}, ${((stopAnchors.short.R / currentPrice) * 100).toFixed(2)}% of price)
- Session range: ${fmt(stopAnchors.long.sessionLow)} – ${fmt(stopAnchors.long.sessionHigh)}
` : '';

  // Listed US options (equity underlier or GLD/SLV metals proxy) — DVOL N/A.
  const hasEquityOptions = isEquityAsset && input.equityOptions != null;
  const hasMetalsOptions = isMetalsAsset && input.equityOptions != null;
  const hasListedOptions = hasEquityOptions || hasMetalsOptions;

  const optionsBlock = optionsInScope
    ? `
**Options** (Deribit DVOL — BTC/ETH only):
- IV Delta: ${flags.ivDeltaPts?.toFixed(2) || 'N/A'} pts (dvol_close - dvol_open)
- IV Expanding: ${flags.ivExpanding ? '✓ (≥+3 pts)' : '✗'}
- IV Compressing: ${flags.ivCompressing ? '✓ (≤-1 pt)' : '✗'}
`
    : hasEquityOptions
      ? `
**Options**: Deribit DVOL is BTC/ETH-only, but ${displayAsset} has REAL listed US options data — see the EQUITY OPTIONS section above. Lead reasoning with that (ATM IV, put/call/skew), never DVOL. Omit thin venue OI from reasoning (do not write that it is N/A).
`
      : hasMetalsOptions
        ? `
**Options**: Deribit DVOL is BTC/ETH-only. For ${displayAsset}, use METALS OPTIONS (GLD/SLV ETF proxy) above + DXY in MACRO BETA. Lead with those. Omit thin venue OI from reasoning. No corporate earnings.
`
        : `
**Options**: Out of scope for ${displayAsset}. Deribit DVOL covers **BTC and ETH only**. This is expected — not a feed outage. Do **not** mention missing IV or options in your reasoning.
`;

  const longOptionsRule = optionsInScope
    ? `4. BTC/ETH IV: dvol_close ≤ dvol_open (compression favors continuation entries) → ivCompressing: ${flags.ivCompressing ? '✓' : '✗'}`
    : hasEquityOptions
      ? `4. Equity options: ATM IV stable/falling with call-tilted flow supports LONG continuation (see EQUITY OPTIONS)`
      : hasMetalsOptions
        ? `4. Metals options + DXY: GLD/SLV call-tilted flow with soft/falling DXY supports LONG continuation (see METALS OPTIONS + MACRO BETA)`
        : `4. Options: skipped for ${displayAsset} (BTC/ETH only) — judge LONG on rules 1–3 alone`;

  const shortOptionsRule = optionsInScope
    ? `4. BTC/ETH IV: dvol_close > dvol_open (expansion favors breakdown continuation) → ivExpanding: ${flags.ivExpanding ? '✓' : '✗'}`
    : hasEquityOptions
      ? `4. Equity options: ATM IV rising with put-tilted flow supports SHORT continuation (see EQUITY OPTIONS)`
      : hasMetalsOptions
        ? `4. Metals options + DXY: GLD/SLV put-tilted flow and/or rising DXY supports SHORT continuation (see METALS OPTIONS + MACRO BETA)`
        : `4. Options: skipped for ${displayAsset} (BTC/ETH only) — judge SHORT on rules 1–3 alone`;

  const citeMetrics = optionsInScope
    ? 'OI Δ%, flow ratio, premium bps, IV delta, and regime (volatility/chop)'
    : hasEquityOptions
      ? 'equity ATM IV / skew / put-call FIRST, then (secondary) premium/funding, brief flow, regime'
      : hasMetalsOptions
        ? 'GLD/SLV ATM IV / put-call + DXY FIRST, then metal EMAs, then (secondary) premium/funding/regime'
        : 'OI Δ%, flow ratio, premium bps, and regime (volatility/chop) — never cite IV/options';

  const tieBreakers = optionsInScope
    ? `7. **Tie-breakers** (when |LongScore−ShortScore| < 5):
   - Premium sign (±≥5bps) → OI Δ% sign → spot flow (sfr3) → IV regime → flow agreement (FR3 & SFR3 same sign)
   - If still tied after IV, pick the side where FR3 and SFR3 point the same way`
    : hasEquityOptions
      ? `7. **Tie-breakers** (when |LongScore−ShortScore| < 5):
   - Equity options (skew / put-call premium) → daily stack → premium sign (±≥5bps) → brief flow
`
      : hasMetalsOptions
        ? `7. **Tie-breakers** (when |LongScore−ShortScore| < 5):
   - GLD/SLV put/call premium tilt → DXY stack → metal EMA/daily stack → premium
`
        : `7. **Tie-breakers** (when |LongScore−ShortScore| < 5):
   - Premium sign (±≥5bps) → OI Δ% sign → spot flow (sfr3) → flow agreement (FR3 & SFR3 same sign)
   - Do not use IV/options (out of scope for ${displayAsset})`;

  const sizingNote = optionsInScope
    ? 'Score = z-score of (buy−sell $), OI Δ%, |premium| bps, IV regime.'
    : hasListedOptions
      ? 'Score = z-score of (buy−sell $), OI Δ%, |premium| bps (listed options temper size).'
      : 'Score = z-score of (buy−sell $), OI Δ%, |premium| bps (options out of scope).';

  const convictionScope = optionsInScope
    ? 'regime, session, liquidations, options, institutional flows'
    : hasEquityOptions
      ? 'regime, session, equity options, daily structure, macro (venue liq clusters only as scalper/swing risk fuel)'
      : hasMetalsOptions
        ? 'regime, GLD/SLV options, DXY, metal EMAs/daily (venue liq clusters only as scalper/swing risk fuel)'
        : 'regime, session, liquidations, institutional flows (options N/A for this asset)';
  
  const windowNote =
    horizon === 'investor'
      ? ' — windows widened ×6 for investor'
      : horizon === 'swing'
        ? ' — windows widened ×4 for swing'
        : '';

  // Put listed options above perp micro so the model reads (and cites) them first.
  const equityOptionsLead = hasListedOptions ? equityOptionsBlock : '';
  const equityOptionsLater = hasListedOptions ? '' : equityOptionsBlock;

  // Equity + metals: thin venue slice (premium/funding + brief flow).
  // Venue OI omitted — thin HIP-3 book ≠ equity/metals positioning (options are).
  // Liq clusters: scalper/swing risk fuel only; investor ignores for thesis.
  const microWeightHint = isMetalsAsset
    ? 'weight below metals options / DXY / EMAs / macro'
    : 'weight below options / EMAs / earnings / macro';
  const hip3LiqBlock =
    horizon === 'investor'
      ? `**Venue liquidations**: ignore for multi-week thesis (investor). Whale liq clusters below are noise unless liquidation distance on YOUR position is threatened.`
      : `**Venue liquidations** (HL/tradeXYZ leverage map — local squeeze/cascade fuel for scalper/swing, NOT global options liquidations; never a directional thesis by itself):
- Sell-liq ≥90th (long wipe): ${flags.liqSell90 ? '✓' : '✗'} | Buy-liq ≥90th (short wipe): ${flags.liqBuy90 ? '✓' : '✗'}
- Opp cluster sell/buy: ${flags.liqOppClusterSell ? '✓' : '✗'} / ${flags.liqOppClusterBuy ? '✓' : '✗'}`;
  const microBlock = isEquityAsset || isMetalsAsset
    ? `**VENUE MICRO** (secondary — this HL/tradeXYZ contract only; ${microWeightHint}; omit thin venue OI from reasoning — never narrate that it is "N/A"/"out of scope"):

**Flow** (brief):
- Flow Ratio (3-bar): ${flags.flowRatio3?.toFixed(2) || 'N/A'} (buy/sell) | Buy strong: ${flags.flowBuyStrong ? '✓' : '✗'} | Sell strong: ${flags.flowSellStrong ? '✓' : '✗'}

**Premium & Funding**:
- Premium: ${flags.premiumBps?.toFixed(1) || 'N/A'} bps (median 10-bar: ${flags.premiumMedian10Bps?.toFixed(1) || 'N/A'}) | Funding: ${flags.fundingRateBps?.toFixed(2) || 'N/A'} bps
- Premium +: ${flags.premPos ? '✓' : '✗'} | Premium −: ${flags.premNeg ? '✓' : '✗'}

${hip3LiqBlock}
${optionsBlock}
**Data Quality**: Futures fresh: ${flags.futuresFresh ? '✓' : '✗'} | Near funding roll: ${flags.nearFundingRoll ? '✓' : '✗'}

**Regime**: **${flags.regimeTag ? flags.regimeTag.toUpperCase() : 'N/A'}** | Bias: **${flags.regimeBias ? flags.regimeBias.toUpperCase() : 'N/A'}** | Vol: ${flags.volatilityState ? flags.volatilityState.toUpperCase() : 'N/A'} | Chop: ${flags.chopRisk ? '⚠️ YES' : 'No'}`
    : `**MICROSTRUCTURE FLAGS** (from ${input.barIntervalLabel ?? '1h'} bars over the last ~5 days; "3-bar" = ${3 * hp.flagWindowScale} hours${windowNote}):

**Flow Metrics**:
- Flow Ratio (3-bar): ${flags.flowRatio3?.toFixed(2) || 'N/A'} (buy/sell)
- Flow Ratio (5-bar): ${flags.flowRatio5?.toFixed(2) || 'N/A'}
- Spot Flow Ratio: ${flags.spotFlowRatio3?.toFixed(2) || 'N/A'}
- Buy Flow Strong: ${flags.flowBuyStrong ? '✓' : '✗'}
- Sell Flow Strong: ${flags.flowSellStrong ? '✓' : '✗'}
- Spot Buy Strong: ${flags.spotBuyStrong ? '✓' : '✗'}
- Spot Sell Strong: ${flags.spotSellStrong ? '✓' : '✗'}

**Flow Path (CVD, last 24 bars)**:
- Futures net taker delta: ${flags.cvdNet24Usd != null ? fmtUsd(flags.cvdNet24Usd) : 'N/A'} | Spot: ${flags.spotCvdNet24Usd != null ? fmtUsd(flags.spotCvdNet24Usd) : 'N/A'}${flags.cvdNet24Usd != null && flags.spotCvdNet24Usd != null ? (Math.sign(flags.cvdNet24Usd) === Math.sign(flags.spotCvdNet24Usd) ? ' (spot CONFIRMS — real demand)' : ' (perp-led, spot disagrees — fragile/squeeze-prone)') : ''}
- One-sidedness (12-bar): ${flags.cvdPersistence12 != null ? `${Math.round(flags.cvdPersistence12 * 100)}%${flags.cvdPersistence12 >= 0.75 ? ' (persistent)' : ' (choppy)'}` : 'N/A'}
- Divergence: ${flags.cvdDivergence === 'bearish' ? '🔴 BEARISH — price higher high, CVD lower high (absorption: do NOT chase longs)' : flags.cvdDivergence === 'bullish' ? '🟢 BULLISH — price lower low, CVD higher low (accumulation: do NOT chase shorts)' : flags.cvdDivergence === 'none' ? 'None' : 'N/A'}

**Open Interest**:
- OI Δ% (3-bar): ${flags.oiDeltaPct3?.toFixed(2) || 'N/A'}%
- OI Up ≥1%: ${flags.oiUp1 ? '✓' : '✗'}
- OI Up ≥0.5%: ${flags.oiUp05 ? '✓' : '✗'}

**Premium & Funding**:
- Premium: ${flags.premiumBps?.toFixed(1) || 'N/A'} bps
- Premium Median (10-bar): ${flags.premiumMedian10Bps?.toFixed(1) || 'N/A'} bps
- Funding Rate: ${flags.fundingRateBps?.toFixed(2) || 'N/A'} bps
- Premium Positive: ${flags.premPos ? '✓' : '✗'}
- Premium Negative: ${flags.premNeg ? '✓' : '✗'}

**Liquidations** (percentile vs 60-bar history):
- Sell Liq Percentile: ${flags.liqSellPctl?.toFixed(0) || 'N/A'}
- Buy Liq Percentile: ${flags.liqBuyPctl?.toFixed(0) || 'N/A'}
- Sell Liq ≥90th: ${flags.liqSell90 ? '✓' : '✗'}
- Buy Liq ≥90th: ${flags.liqBuy90 ? '✓' : '✗'}
- Opp Cluster (Sell): ${flags.liqOppClusterSell ? '✓ (≥2 of last 3 bars)' : '✗'}
- Opp Cluster (Buy): ${flags.liqOppClusterBuy ? '✓ (≥2 of last 3 bars)' : '✗'}
${optionsBlock}
**Data Quality**:
- Futures Fresh: ${flags.futuresFresh ? '✓' : '✗'} (latest bar within one bar interval)
- Spot Fresh: ${flags.spotFresh ? '✓' : '✗'} (latest bar within one bar interval)
- Near Funding Roll: ${flags.nearFundingRoll ? '✓' : '✗'} (first 30min after 00/08/16 UTC)

**Regime Context**:
- Regime: **${flags.regimeTag ? flags.regimeTag.toUpperCase() : 'N/A'}** | Directional Bias: **${flags.regimeBias ? flags.regimeBias.toUpperCase() : 'N/A'}** (price/flow/OI/premium vote)
- Volatility State: ${flags.volatilityState ? flags.volatilityState.toUpperCase() : 'N/A'}
- Liquidity State: ${flags.liquidityState ? flags.liquidityState.toUpperCase() : 'N/A'}
- Trend Consistency: ${typeof flags.trendConsistency === 'number' ? `${(flags.trendConsistency * 100).toFixed(0)}%` : 'N/A'}
- Chop Risk: ${flags.chopRisk ? '⚠️ YES — default to patience/min size' : 'No'}
- Range Compression: ${flags.rangeCompression ? 'Yes (tight ranges)' : 'No'}`;

  return `${persona}

**ASSET**: ${displayAsset}${hip3 ? ` (${classLabel(aClass)})` : ''}
**CURRENT PRICE**: $${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
**TIMESTAMP**: ${new Date().toISOString()}
${equityOptionsLead}
${microBlock}
${sessionBlock}${xyzSessionBlock}${bookBlock}${calendarBlock}${stickyBlock}${tickerCatalystBlock}${lastCloseBlock}${dailyBlock}${emaBlock}${betaBlock}${earningsBlock}${equityOptionsLater}${etfBlock}${positioningBlock}${whaleBlock}${optionsPositioningBlock}${moodBlock}${extensionBlock}${horizonBlock}${mandateBlock}${profileBlock}

**COMPOSITE SCORES** (0-100):
- Long Score: ${score.longScore} | Drivers: ${score.driversLong.join(', ') || 'none'}
- Short Score: ${score.shortScore} | Drivers: ${score.driversShort.join(', ') || 'none'}
${anchorsBlock}
**RISK PARAMETERS** (calculate based on your decision):
- For LONG: stop < entry < take_profit
- For SHORT: take_profit < entry < stop
- R (risk distance) = |entry - stop| — anchor to the RISK ANCHORS above when provided
- Take profit MUST be ${hp.tpGuidance}. A 1:1 target is
  negative-EV after fees and slippage — never use it.
- Your stop distance directly sets position size (notional = risk budget /
  stop distance). An artificially tight stop buys a bigger position that
  noise then clips — pick the STRUCTURALLY correct stop, not a size hack.

---

**REFERENCE SETUPS** (textbook patterns — NOT necessary conditions):

These are known-good confluence patterns. Their ABSENCE does not mandate FLAT:
you are an independent analyst, not a checklist executor. If the raw metrics
support a directional thesis these templates miss, you may trade it — state
the thesis and cite the specific metrics that support it. Expect to sometimes
disagree with the composite scores and with other analysts.

**LONG BIAS** (textbook long) if ALL:
1. flowRatio3 ≥ 1.20 AND flowRatio5 ≥ 1.10 AND 3-bar dollar_volume ≥ 30th pct of last 60 bars → flowBuyStrong: ${flags.flowBuyStrong ? '✓' : '✗'}, FR5: ${flags.flowRatio5?.toFixed(2) || 'N/A'}
${hasListedOptions
    ? `2. Listed options / daily structure support upside (call tilt or bullish stack — see EQUITY/METALS OPTIONS + DAILY STRUCTURE; venue OI is NOT a requirement)`
    : `2. dollar_open_interest_close ↑ ≥ 1% (vs 3 bars ago) → oiUp1: ${flags.oiUp1 ? '✓' : '✗'}`}
3. premium ≥ +10 bps OR spot buy > sell → premPos: ${flags.premPos ? '✓' : '✗'}, spotBuyStrong: ${flags.spotBuyStrong ? '✓' : '✗'}
${longOptionsRule}

**SHORT BIAS** (textbook short) if ALL:
1. flowRatio3 ≤ 0.83 AND flowRatio5 ≤ 0.91 AND 3-bar dollar_volume ≥ 30th pct of last 60 bars → flowSellStrong: ${flags.flowSellStrong ? '✓' : '✗'}, FR5: ${flags.flowRatio5?.toFixed(2) || 'N/A'}
${hasListedOptions
    ? `2. Listed options / daily structure support downside (put skew/tilt or bearish stack — see EQUITY/METALS OPTIONS + DAILY STRUCTURE; venue OI is NOT a requirement)`
    : `2. dollar_open_interest_close ↑ ≥ 1% → oiUp1: ${flags.oiUp1 ? '✓' : '✗'}`}
3. premium ≤ −10 bps OR spot sell > buy → premNeg: ${flags.premNeg ? '✓' : '✗'}, spotSellStrong: ${flags.spotSellStrong ? '✓' : '✗'}
${shortOptionsRule}

**FADE SQUEEZE SETUP** (smaller size, tight stop):
- Long wipe: sell_liquidations ≥ 90th pct → liqSell90: ${flags.liqSell90 ? '✓' : '✗'}
- Short wipe: buy_liquidations ≥ 90th pct → liqBuy90: ${flags.liqBuy90 ? '✓' : '✗'}

**SIZING**:
Base size × flow-strength score, capped at 2×.
${sizingNote}

**CRITICAL RULES**:
1. **TRADE ONLY WITH EDGE**: Choose LONG or SHORT when signals align and
   conviction ≥ ${minConviction} (${thinHours ? (crypto ? 'thin-hours' : 'off-session') : 'normal'} gate).${
     probesEnabled
       ? ` With conviction ${probeFloor}-${minConviction - 1} you may
   STILL pick a direction as a tiny exploratory PROBE (size 0.1) when one side
   is clearly better — a probe keeps the agent engaged at minimal risk instead
   of sitting out every mildly-unclear bar.`
       : ` There is NO probe tier for this horizon — below the gate, return FLAT.`
   } Return FLAT when conviction
   < ${probeFloor}, signals genuinely conflict, or a guard below applies. A skipped
   bad trade costs nothing; a forced one costs fees plus risk.${earningsGate}${trendGate}${
     hip3 && thinHours
       ? `
- **OFF-SESSION**: pricing is internal / discovery-bound. Prefer patience or small size; do not chase thin-book moves as if the cash market were open.`
       : ''
   }${
     horizon === 'investor'
       ? `
- **INVESTOR LEVERAGE**: keep planned leverage low (≤3x guidance) so wide stops remain survivable.`
       : ''
   }
2. **Conviction is YOUR holistic judgment** — of the full picture: flags,
   ${convictionScope}${hip3 ? ', EMA stack, macro beta' : ''}${aClass === 'equity' ? ', earnings' : ''}. The composite
   scores are ONE deterministic input with known blind spots, not the answer
   key. You may disagree with them in either direction when you cite why.
   Calibrate honestly: ${minConviction} = "barely tradeable probe", 50 = "decent setup",
   70 = "strong confluence", 85+ = "rare, nearly everything aligns".
3. **Conviction ↔ Size coupling** (size sets your per-trade RISK budget —
   the engine converts it to notional via your stop distance, risk-parity
   style: wider stop ⇒ smaller notional, same dollars at risk. Sizes above
   your conviction band are rejected):
${probesEnabled ? `   - Conviction ${probeFloor}-${minConviction - 1}: size = 0.1 (exploratory probe — direction only, tiny)
` : ''}   - Conviction ${probeBandLabel}: size = 0.2 (probe)
   - Conviction 45-59: size = 0.4
   - Conviction 60-69: size = 0.6
   - Conviction ≥ 70: size = 0.8 (maximum)
4. **Data Quality Override**: 
   - If futuresFresh = ✗ or spotFresh = ✗ → size = 0.2 regardless of conviction
   - If nearFundingRoll = ✓ and conviction < 70 → downgrade size by one band (0.8→0.6→0.4→0.2)
5. **Session Guard**:
   - Enforced conviction gate for this decision: **≥ ${minConviction}** (probe tier from ${probeFloor}).
${thinHours
    ? `   - Thin hours: default size is halved; prefer patience and explain when you stay FLAT. Off-US hours compound the thin tape — do not force size.`
    : activeEntry
      ? `   - Off-US hours: prefer one size band smaller, but quiet sessions still resolve into trends — sidelining is NOT required. Position small rather than skip when a side is better.`
      : `   - When US session is closed, default size is halved; prefer patience and explain when you stay FLAT.`}
6. **Chop Guard**:
${activeEntry && !thinHours
    ? `   - If chopRisk = ✓ OR volatilityState = LOW and |LongScore−ShortScore| < 10 → cap size at 0.2 and prefer the PROBE tier over FLAT when a side is even mildly better. Cite chop conditions in reasoning.`
    : `   - If chopRisk = ✓ OR volatilityState = LOW and |LongScore−ShortScore| < 10 → you may choose **FLAT** (size 0) or minimum size 0.2. Explicitly cite chop conditions in reasoning.`}
   - Do NOT recommend flips during chop unless trendConsistency ≥ 60% and volatility ≠ LOW.${extensionRules}
${tieBreakers}
8. Stop = session range (H−L) based, not fixed %
9. Cite SPECIFIC metrics (${citeMetrics}) in reasoning
${hasEquityOptions
    ? `10. **Equity options lead**: the first sentence(s) of "reasoning" MUST cover EQUITY OPTIONS (ATM IV, skew, put/call) before premium/funding. Omit venue OI entirely (do not write that it is N/A). Venue liqs only as scalper/swing squeeze fuel when material.
`
      : hasMetalsOptions
        ? `10. **Metals options + DXY lead**: the first sentence(s) of "reasoning" MUST cover METALS OPTIONS (GLD/SLV ATM IV, put/call) and DXY before venue premium. Omit venue OI entirely. No corporate earnings for gold/silver.
`
      : ''}
---

**YOUR TASK**:
Decide LONG, SHORT, or FLAT for ${displayAsset}. The position is protected by
on-exchange stop-loss / take-profit and re-reviewed by a monitor on a recurring
cycle — your horizon is "until stop, target, or thesis invalidation", not a
fixed clock.

**IMPORTANT**: 
- Choose LONG or SHORT when conviction ≥ ${minConviction}% and signals align. With conviction ${probeFloor}-${minConviction - 1}% and one side clearly better, prefer a 0.1-size PROBE over FLAT. Return **FLAT** (no trade) when conviction < ${probeFloor}%, signals genuinely conflict, or **Chop Guard** conditions are met (volatility = LOW or chopRisk = YES AND edge < 10) — and explain why you're sidelined.
- LONG/SHORT = Open position with stop-loss and take-profit
- FLAT = No order; set size to 0 and reuse current price for entry/stop/take-profit (they will be ignored but must be valid numbers)
${
  !optionsInScope && !hasListedOptions
    ? `- Do **not** write that IV/gamma/options are "unavailable" or "missing" — Deribit DVOL is BTC/ETH-only and this asset has no listed-options block; that is expected, not a feed outage.\n`
    : hasEquityOptions
      ? `- Listed US equity options ARE in scope for ${displayAsset} (EQUITY OPTIONS is the PRIMARY signal). Open "reasoning" with ATM IV / put-call; do **not** say options are unavailable or out of scope.\n`
      : hasMetalsOptions
        ? `- GLD/SLV listed options ARE in scope for ${displayAsset} (METALS OPTIONS + DXY are PRIMARY). Open "reasoning" with ATM IV / put-call and dollar trend; do **not** invent corporate earnings or say options are unavailable.\n`
        : ''
}
Return ONLY valid JSON (no markdown, no code fences):
{
  "decision": "LONG" | "SHORT" | "FLAT",
  "conviction": 0-100,
  "size": 0.1-0.8 (fraction of base position; 0.1 only for sub-gate probes) or 0 if decision = "FLAT",
  "entry_price": ${currentPrice.toFixed(2)},
  "stop_price": absolute price level (calculate based on your decision; use entry price if FLAT),
  "take_profit_target": absolute price level (calculate based on your decision; use entry price if FLAT),
  "R": stop distance in dollars (calculate based on your decision; 0 if FLAT),
  "addTrigger": "conditions for pyramiding (if any)",
  "invalidation_criteria": ["2-4 CONCRETE, CHECKABLE conditions that would prove this thesis wrong (e.g. 'premium flips below -5 bps', 'put skew flips call-favoring', '4h close below $X'${hasListedOptions ? "; avoid venue-OI criteria — thin HIP-3 OI is not equity positioning" : ", 'OI drops >1% while price holds'"}). Empty array if FLAT."],
  "key_metrics": {
    "oiDeltaPct": ${flags.oiDeltaPct3},
    "flowRatio": ${flags.flowRatio3},
    "premiumBps": ${flags.premiumBps},
    "ivDelta": ${optionsInScope ? flags.ivDeltaPts : null}${
      crypto && input.cryptoExtension
        ? `,
    "rsi4h": ${input.cryptoExtension.rsi4h},
    "rsi1d": ${input.cryptoExtension.rsi1d},
    "runUp3dPct": ${input.cryptoExtension.runUp3dPct},
    "runUp3dPctl": ${input.cryptoExtension.runUp3dPctl},
    "vsEma1dPct": ${input.cryptoExtension.vsEma1dPct},
    "fundingPctl": ${input.cryptoExtension.fundingPctl},
    "stretched": ${input.cryptoExtension.stretched},
    "oversold": ${input.cryptoExtension.oversold}`
        : ''
    }
  },
  "reasoning": "${hasEquityOptions
    ? `LEAD with EQUITY OPTIONS (ATM IV, skew, put/call), then daily structure / macro / ticker catalysts when relevant; secondary premium/funding only if material. Cite ${citeMetrics}. Do not narrate venue OI or that it is out of scope.`
      : hasMetalsOptions
        ? `LEAD with METALS OPTIONS (GLD/SLV ATM IV, put/call) + DXY, then metal EMAs/daily; secondary premium only if material. Cite ${citeMetrics}. Do not narrate venue OI.`
      : `concise explanation citing ${citeMetrics}.`} If FLAT, explicitly mention low conviction / conflicting signals / chop guard.",
  "summary": "MUST begin with exact prefix 'Summary: ' then 1-2 plain-English sentences a non-trader understands — the story behind the trade (macro backdrop, momentum, crowd behavior), NO raw metrics/abbreviations (no OI, bps, CVD) and NO min-order / leftover-size mechanics. Example: 'Summary: Going long ${displayAsset}: buyers keep stepping in on dips and the broader market backdrop supports more upside. Risk is controlled with a stop just below recent support.'"
}

**NOTE**: FLAT is a legitimate answer when conviction < ${probeFloor}%, signals genuinely conflict, or guards apply. Otherwise pick the side with better signals — full size above the gate, 0.1 probe just under it.`;
}

export function validateOpeningResponse(response: any, input?: OpeningPromptInput): OpeningPromptOutput {
  if (!response || typeof response !== 'object') {
    throw new Error('Invalid response format');
  }
  
  if (!['LONG', 'SHORT', 'FLAT'].includes(response.decision)) {
    throw new Error('Invalid decision: must be LONG, SHORT, or FLAT');
  }
  
  if (typeof response.conviction !== 'number' || response.conviction < 0 || response.conviction > 100) {
    throw new Error('Invalid conviction: must be 0-100');
  }

  const isFlatDecision = response.decision === 'FLAT';

  // Auto-fix missing numerics using current price (especially for FLAT responses)
  const fallbackPrice =
    typeof input?.currentPrice === 'number' && Number.isFinite(input.currentPrice)
      ? Number(input.currentPrice)
      : undefined;

  if (!Number.isFinite(response.entry_price) && fallbackPrice !== undefined) {
    response.entry_price = fallbackPrice;
  }

  if (isFlatDecision) {
    if (!Number.isFinite(response.size)) {
      response.size = 0;
    }
    if (!Number.isFinite(response.entry_price) && fallbackPrice !== undefined) {
      response.entry_price = fallbackPrice;
    }
    if (!Number.isFinite(response.stop_price)) {
      response.stop_price = response.entry_price;
    }
    if (!Number.isFinite(response.take_profit_target)) {
      response.take_profit_target = response.entry_price;
    }
    if (typeof response.R !== 'number' || !Number.isFinite(response.R)) {
      response.R = 0;
    }
  }
  
  // Validate required numeric fields
  const requiredFields = ['size', 'entry_price', 'stop_price', 'take_profit_target', 'R'];
  for (const field of requiredFields) {
    if (typeof response[field] !== 'number' || !Number.isFinite(response[field])) {
      if (isFlatDecision && field === 'R' && response[field] === 0) {
        continue;
      }
      throw new Error(`${field} must be a finite number`);
    }
  }
  
  // Clamp size into the allowed band. 0.1 is the exploratory-probe floor
  // (sub-gate conviction); rejecting near-miss sizes used to drop a valid
  // LONG/SHORT as opening_invalid with no trade and a blank UI body.
  if (!isFlatDecision) {
    if (typeof response.size !== 'number' || !Number.isFinite(response.size)) {
      throw new Error('size must be a finite number');
    }
    if (response.size < 0.1) response.size = 0.1;
    if (response.size > 0.8) response.size = 0.8;

    // Conviction ↔ size coupling (hard): size can never exceed what the
    // model's own conviction band allows — prevents "35 conviction, 0.8 size"
    // incoherence regardless of which model produced the reply. Sub-gate
    // conviction is capped at the 0.1 exploratory probe (the worker's
    // probe-floor gate decides whether it trades at all).
    const conv = Number(response.conviction);
    const bandMax =
      conv >= 70 ? 0.8 : conv >= 60 ? 0.6 : conv >= 45 ? 0.4 : conv >= 25 ? 0.2 : 0.1;
    if (response.size > bandMax) {
      console.warn(
        `⚠️ size ${response.size} exceeds conviction band (conv=${conv}, max=${bandMax}) — clamping`,
      );
      response.size = bandMax;
    }
  }

  // Sanity checks for stop/target logic
  const isLong = response.decision === 'LONG';
  const e = response.entry_price;
  const s = response.stop_price;
  const tp = response.take_profit_target;
  const R = response.R;

  if (!isFlatDecision && R <= 0) {
    throw new Error('R must be > 0');
  }
  
  if (!isFlatDecision) {
    let Rcalc = Math.abs(e - s);
    if (!Number.isFinite(Rcalc) || Rcalc <= 0) {
      throw new Error('Invalid stop/entry configuration');
    }

    if (Math.abs(Rcalc - R) / R > 0.05) {
      console.warn(
        `⚠️ R mismatch vs stop/entry distance (AI=${R}, calc=${Rcalc}). Auto-correcting R to ${Rcalc}`,
      );
      response.R = Rcalc;
      Rcalc = Math.abs(e - s);
    }
    
    console.log(`🔍 Stop/TP validation:`, {
      decision: response.decision,
      stop: s,
      entry: e,
      takeProfit: tp,
      longValid: isLong ? (s < e && e < tp) : 'N/A',
      shortValid: !isLong ? (tp < e && e < s) : 'N/A'
    });
    
    if (isLong) {
      if (!(s < e && e < tp)) {
        throw new Error(`LONG: require stop < entry < take_profit (got stop=${s}, entry=${e}, tp=${tp})`);
      }
    } else {
      if (!(tp < e && e < s)) {
        throw new Error(`SHORT: require take_profit < entry < stop (got tp=${tp}, entry=${e}, stop=${s})`);
      }
    }

    // Enforce the reward floor: TP < 1.2R is negative-EV after fees — stretch
    // to 1.5R rather than rejecting an otherwise-valid direction call.
    const Rfinal = Math.abs(e - s);
    const tpDist = Math.abs(tp - e);
    // Horizon-aware reward floor (scalper 1.5R, swing 2R).
    const floorR = HORIZON_PROFILES[normalizeHorizon(input?.horizon)].tpFloorR;
    if (tpDist < 0.8 * floorR * Rfinal) {
      const stretched = isLong ? e + floorR * Rfinal : e - floorR * Rfinal;
      console.warn(
        `⚠️ TP too close (${(tpDist / Rfinal).toFixed(2)}R) — stretching to ${floorR}R: ${stretched}`,
      );
      response.take_profit_target = stretched;
    }
  }

  // Sanitize summary (display-only; force "Summary: " prefix; never fed back to LLMs).
  sanitizeMonitorSummary(response);

  // Sanitize invalidation_criteria (untrusted LLM output → stored on the row).
  if (Array.isArray(response.invalidation_criteria)) {
    response.invalidation_criteria = response.invalidation_criteria
      .filter((c: unknown) => typeof c === 'string' && (c as string).trim().length > 0)
      .slice(0, 4)
      .map((c: string) => {
        const cleaned = stripHip3DexPrefix(c);
        return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
      });
  } else {
    response.invalidation_criteria = [];
  }

  return response as OpeningPromptOutput;
}
