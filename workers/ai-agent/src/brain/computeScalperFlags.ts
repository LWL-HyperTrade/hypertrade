/**
 * Scalper Flags Computation
 * 
 * Lean, dependency-free helpers to turn Velo rows into actionable scalper flags + scores.
 * Works with fetchVeloData() shape: { futures.timeSeries, options.timeSeries, spot.timeSeries }.
 */

export type Side = 'long' | 'short'
export type Action = 'flat' | 'open' | 'hold' | 'add' | 'trim' | 'exit' | 'cut' | 'flip'

export interface FuturesBar {
  timestamp: number
  open_price?: number
  high_price?: number
  low_price?: number
  close_price?: number
  coin_volume?: number
  dollar_volume?: number
  buy_trades?: number
  sell_trades?: number
  total_trades?: number
  buy_coin_volume?: number
  sell_coin_volume?: number
  buy_dollar_volume?: number
  sell_dollar_volume?: number
  coin_open_interest_high?: number
  coin_open_interest_low?: number
  coin_open_interest_close?: number
  dollar_open_interest_high?: number
  dollar_open_interest_low?: number
  dollar_open_interest_close?: number
  funding_rate?: number
  funding_rate_avg?: number
  premium?: number
  buy_liquidations?: number
  sell_liquidations?: number
  buy_liquidations_coin_volume?: number
  sell_liquidations_coin_volume?: number
  liquidations_coin_volume?: number
  buy_liquidations_dollar_volume?: number
  sell_liquidations_dollar_volume?: number
  liquidations_dollar_volume?: number
  [k: string]: any
}

export interface OptionsBar {
  timestamp: number
  gamma_dollars?: number
  call_delta_dollars?: number
  put_delta_dollars?: number
  dvol_open?: number
  dvol_close?: number
  iv_1w?: number
  skew_1w?: number
  [k: string]: any
}

export interface SpotBar {
  timestamp: number
  buy_dollar_volume?: number
  sell_dollar_volume?: number
  dollar_volume?: number
  buy_trades?: number
  sell_trades?: number
  [k: string]: any
}

export interface ScalperFlags {
  // numeric features (last N windows)
  flowRatio3: number | null
  flowRatio5: number | null
  spotFlowRatio3: number | null
  oiDeltaPct3: number | null
  premiumBps: number | null
  premiumMedian10Bps: number | null
  fundingRateBps: number | null
  ivDeltaPts: number | null // dvol_close - dvol_open (latest)
  gammaTercile: 'low' | 'mid' | 'high' | 'na'
  liqSellPctl: number | null // 0..100, latest vs 60-bar hist
  liqBuyPctl: number | null  // 0..100, latest vs 60-bar hist
  volumeZScore: number | null
  realizedRangePct: number | null

  // CVD (cumulative taker delta) path features — derived locally from the
  // taker buy/sell series (same data the CoinGlass CVD endpoints cumsum).
  /** Net futures taker delta (buy$ − sell$) over the last 24 bars. */
  cvdNet24Usd: number | null
  /** Net spot taker delta over the last 24 bars (spot confirmation). */
  spotCvdNet24Usd: number | null
  /** 0..1 — fraction of the last 12 bars whose delta matches the net sign. */
  cvdPersistence12: number | null
  /** Price/CVD divergence over the last 24 bars (12 vs 12). */
  cvdDivergence: 'bullish' | 'bearish' | 'none' | 'na'

  // booleans for quick rules
  flowBuyStrong: boolean
  flowSellStrong: boolean
  spotBuyStrong: boolean
  spotSellStrong: boolean
  oiUp1: boolean
  oiUp05: boolean
  
  // new data quality and timing flags
  futuresFresh: boolean
  spotFresh: boolean
  nearFundingRoll: boolean
  premPos: boolean
  premNeg: boolean
  ivExpanding: boolean
  ivCompressing: boolean
  gammaHigh: boolean
  gammaLow: boolean
  liqSell90: boolean
  liqBuy90: boolean
  liqOppClusterSell: boolean // ≥2 of last 3 bars had high sell-liqs
  liqOppClusterBuy: boolean  // ≥2 of last 3 bars had high buy-liqs
  volatilityState: 'low' | 'normal' | 'high'
  liquidityState: 'thin' | 'normal' | 'thick'
  trendConsistency: number
  regimeBias: 'long' | 'short' | 'neutral'
  regimeTag: 'trend' | 'balance' | 'transition'
  rangeCompression: boolean
  chopRisk: boolean
}

export interface CompositeScore {
  longScore: number // 0..100
  shortScore: number // 0..100
  driversLong: string[]
  driversShort: string[]
}

export interface ComputeInput {
  futures: { timeSeries: FuturesBar[] } | null
  options?: { timeSeries: OptionsBar[] } | null
  spot?: { timeSeries: SpotBar[] } | null
}

// ====== HELPERS ======

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const last = <T>(arr: T[]) => arr.length ? arr[arr.length - 1] : undefined
const takeLast = <T>(arr: T[], n: number) => arr.slice(Math.max(0, arr.length - n))
const sum = (arr: (number | undefined)[]) => arr.reduce<number>((s, v) => s + (Number.isFinite(v as number) ? (v as number) : 0), 0)
const mean = (arr: number[]) => {
  const vals = arr.filter(Number.isFinite)
  if (!vals.length) return NaN
  return vals.reduce((acc, v) => acc + v, 0) / vals.length
}
const stddev = (arr: number[]) => {
  const vals = arr.filter(Number.isFinite)
  if (vals.length < 2) return NaN
  const avg = mean(vals)
  const variance = vals.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / (vals.length - 1)
  return Math.sqrt(variance)
}
const median = (arr: number[]) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y)
  if (!a.length) return NaN
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
const quantile = (arr: number[], q: number) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y)
  if (!a.length) return NaN
  const pos = (a.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base])
  return a[base]
}
const percentileRank = (arr: number[], v: number) => {
  const a = arr.filter(Number.isFinite).slice().sort((x, y) => x - y)
  if (!a.length || !Number.isFinite(v)) return NaN
  let count = 0
  for (const x of a) if (x <= v) count++
  return (count / a.length) * 100
}

function ratioSafe(n: number, d: number) {
  const den = (Number.isFinite(d) && Math.abs(d) > 1e-12) ? d : NaN
  return Number.isFinite(den) ? n / den : NaN
}

/**
 * Build flags from the most recent window (default 60 bars).
 *
 * `windowScale` (trading-horizon knob): multiplies the LOOKBACK of the
 * directional features — flow (3/5-bar), OI Δ, CVD windows, trend anchor —
 * so a swing agent (scale 4) reads "3-bar flow" as 12 hours of 1h bars from
 * the SAME fetched series. Regime/percentile machinery (60-bar hist, volume
 * z-score, liq percentiles, freshness) is horizon-independent and unscaled.
 */
export function computeScalperFlags(
  input: ComputeInput,
  histWindow: number = 60,
  windowScale: number = 1,
): ScalperFlags {
  const fut = input.futures?.timeSeries ?? []
  const opt = input.options?.timeSeries ?? []
  const spot = input.spot?.timeSeries ?? []

  const ws = Math.max(1, Math.round(windowScale))
  const w = (n: number) => n * ws

  const fLast = last(fut)
  const fLast3 = takeLast(fut, w(3))
  const fLast5 = takeLast(fut, w(5))
  const fHist = takeLast(fut, histWindow)

  // Volume floor for flow signals (30th percentile of last 60 bars)
  const fHist60 = takeLast(fut, 60)
  const dvHist = fHist60.map(b => (b.dollar_volume ?? 0))
  const dvP30 = quantile(dvHist, 0.30)
  // Per-bar average so the floor is comparable across window scales.
  const dv3 = sum(fLast3.map(b => b.dollar_volume ?? 0)) / Math.max(1, w(3)) * 3
  const volOk = Number.isFinite(dv3) && dv3 >= dvP30

  // Flow ratios (futures)
  const buy3 = sum(fLast3.map(b => b.buy_dollar_volume))
  const sell3 = sum(fLast3.map(b => b.sell_dollar_volume))
  const buy5 = sum(fLast5.map(b => b.buy_dollar_volume))
  const sell5 = sum(fLast5.map(b => b.sell_dollar_volume))
  const fr3 = ratioSafe(buy3, sell3)
  const fr5 = ratioSafe(buy5, sell5)

  // Spot flow ratios (optional)
  const sLast3 = takeLast(spot, w(3))
  const sBuy3 = sum(sLast3.map(b => b.buy_dollar_volume))
  const sSell3 = sum(sLast3.map(b => b.sell_dollar_volume))
  const sfr3 = ratioSafe(sBuy3, sSell3)

  // OI change vs 3 bars ago (window-scaled)
  const oiNow = fLast?.dollar_open_interest_close
  const oiAgo = fut.length >= w(3) + 1 ? fut[fut.length - 1 - w(3)]?.dollar_open_interest_close : undefined
  const oiDeltaPct3 = (Number.isFinite(oiNow) && Number.isFinite(oiAgo) && oiAgo! !== 0)
    ? ((oiNow! - oiAgo!) / oiAgo!) * 100
    : NaN

  // ── CVD path features (local cumsum of taker deltas — no extra endpoint) ──
  // The instantaneous flow ratios above are memoryless; these capture the
  // PATH: how one-sided flow has been, and whether price and cumulative
  // delta disagree (absorption / accumulation).
  const barDelta = (b: FuturesBar | SpotBar): number => {
    const buy = b.buy_dollar_volume
    const sell = b.sell_dollar_volume
    return Number.isFinite(buy as number) && Number.isFinite(sell as number)
      ? (buy as number) - (sell as number)
      : NaN
  }
  const netDelta = (bars: (FuturesBar | SpotBar)[], n: number): number => {
    const ds = takeLast(bars, n).map(barDelta).filter(Number.isFinite) as number[]
    return ds.length >= Math.min(6, n) ? ds.reduce((s, v) => s + v, 0) : NaN
  }
  const cvdNet24 = netDelta(fut, w(24))
  const spotCvdNet24 = netDelta(spot, w(24))

  // One-sidedness: share of the last 12 bars whose delta sign matches the net.
  let cvdPersistence = NaN
  {
    const ds = takeLast(fut, w(12)).map(barDelta).filter(Number.isFinite) as number[]
    const net12 = ds.reduce((s, v) => s + v, 0)
    if (ds.length >= 6 && net12 !== 0) {
      const sign = Math.sign(net12)
      cvdPersistence = ds.filter(d => Math.sign(d) === sign).length / ds.length
    }
  }

  // Divergence over 24 bars (recent 12 vs prior 12), on close extremes vs the
  // CVD path at the same halves. Needs a real new extreme (>0.1% beyond the
  // prior half) so flat chop can't fabricate divergences.
  let cvdDivergence: ScalperFlags['cvdDivergence'] = 'na'
  {
    const win = takeLast(fut, w(24))
    const closes = win.map(b => b.close_price ?? NaN)
    const deltas = win.map(barDelta)
    const finiteCloses = closes.filter(Number.isFinite).length
    const finiteDeltas = deltas.filter(Number.isFinite).length
    if (win.length >= w(20) && finiteCloses >= w(16) && finiteDeltas >= w(16)) {
      let acc = 0
      const path = deltas.map(d => (acc += Number.isFinite(d) ? d : 0))
      const half = Math.floor(win.length / 2)
      const hi = (a: number[]) => Math.max(...a.filter(Number.isFinite))
      const lo = (a: number[]) => Math.min(...a.filter(Number.isFinite))
      const pHiPrior = hi(closes.slice(0, half)); const pHiRecent = hi(closes.slice(half))
      const pLoPrior = lo(closes.slice(0, half)); const pLoRecent = lo(closes.slice(half))
      const cHiPrior = hi(path.slice(0, half)); const cHiRecent = hi(path.slice(half))
      const cLoPrior = lo(path.slice(0, half)); const cLoRecent = lo(path.slice(half))
      const bearish = pHiRecent > pHiPrior * 1.001 && cHiRecent < cHiPrior
      const bullish = pLoRecent < pLoPrior * 0.999 && cLoRecent > cLoPrior
      cvdDivergence = bearish && !bullish ? 'bearish' : bullish && !bearish ? 'bullish' : 'none'
    }
  }

  // Premium / Funding (bps) - Fixed scaling issue
  const premNow = fLast?.premium
  // Detect if premium is already in basis points or needs conversion
  // If premium is already in reasonable bps range (-100 to 100), use as-is
  // Otherwise, convert from decimal (multiply by 10,000)
  let premBps: number
  if (Number.isFinite(premNow as number)) {
    const prem = premNow as number
    // If premium is already in bps range (reasonable values), use as-is
    if (Math.abs(prem) <= 1000) {
      premBps = prem
    } else {
      // Convert from decimal to bps
      premBps = prem * 10_000
    }
    // Clamp to reasonable intraday range (±250 bps)
    premBps = Math.max(-250, Math.min(250, premBps))
  } else {
    premBps = NaN
  }
  
  const premMed10Bps = median(takeLast(fut, 10).map(b => {
    const p = b.premium ?? NaN
    if (Number.isFinite(p)) {
      const scaled = Math.abs(p) <= 1000 ? p : p * 10_000
      return Math.max(-250, Math.min(250, scaled))
    }
    return NaN
  }))
  const frRaw = (() => {
    // The forming bar often has no funding print yet. Use the latest rate
    // within a few bars so a live check does not go N/A an hour after open.
    const start = Math.max(0, fut.length - 4)
    for (let i = fut.length - 1; i >= start; i -= 1) {
      const n = Number(fut[i]?.funding_rate)
      if (Number.isFinite(n)) return n
    }
    return NaN
  })()
  const frBps = frRaw * 10_000

  // Liq percentiles
  const sellLiqHist = fHist.map(b => b.sell_liquidations_dollar_volume ?? 0)
  const buyLiqHist  = fHist.map(b => b.buy_liquidations_dollar_volume ?? 0)
  const sellLiqNow = fLast?.sell_liquidations_dollar_volume ?? NaN
  const buyLiqNow  = fLast?.buy_liquidations_dollar_volume ?? NaN
  const sellPctl = Number.isFinite(sellLiqNow) ? percentileRank(sellLiqHist, sellLiqNow) : NaN
  const buyPctl  = Number.isFinite(buyLiqNow)  ? percentileRank(buyLiqHist,  buyLiqNow)  : NaN

  // 3-bar clusters (>=85th pct two of last three)
  const sell85 = quantile(sellLiqHist, 0.85)
  const buy85  = quantile(buyLiqHist,  0.85)
  const last3SellHigh = fLast3.filter(b => (b.sell_liquidations_dollar_volume ?? -1) >= sell85).length
  const last3BuyHigh  = fLast3.filter(b => (b.buy_liquidations_dollar_volume  ?? -1) >= buy85).length

  // Regime context helpers
  const rangePctSeries = fHist
    .map(b => {
      const high = b.high_price ?? b.close_price ?? NaN
      const low = b.low_price ?? b.close_price ?? NaN
      const close = b.close_price ?? b.open_price ?? NaN
      if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || close === 0) {
        return NaN
      }
      return ((high - low) / close) * 100
    })
    .filter(Number.isFinite) as number[]
  const realizedRangePctRaw = rangePctSeries.length ? median(takeLast(rangePctSeries, 20)) : NaN
  const rangePercentile = Number.isFinite(realizedRangePctRaw)
    ? percentileRank(rangePctSeries, realizedRangePctRaw)
    : NaN
  let volatilityState: ScalperFlags['volatilityState'] = 'normal'
  if (Number.isFinite(rangePercentile) && rangePctSeries.length >= 12) {
    if (rangePercentile <= 35) {
      volatilityState = 'low'
    } else if (rangePercentile >= 70) {
      volatilityState = 'high'
    }
  }
  const rangeCompression = volatilityState === 'low' && (Number.isFinite(rangePercentile) ? rangePercentile <= 45 : true)

  const volumeSeries = fHist.map(b => b.dollar_volume ?? NaN).filter(Number.isFinite) as number[]
  const lastVolume = Number(fLast?.dollar_volume)
  const volMean = mean(volumeSeries)
  const volStd = stddev(volumeSeries)
  const volumeZ =
    Number.isFinite(lastVolume) && Number.isFinite(volMean) && Number.isFinite(volStd) && volStd > 0
      ? (lastVolume - volMean) / volStd
      : NaN
  let liquidityState: ScalperFlags['liquidityState'] = 'normal'
  if (Number.isFinite(volumeZ)) {
    if (volumeZ <= -0.5) liquidityState = 'thin'
    else if (volumeZ >= 0.5) liquidityState = 'thick'
  }

  const priceWindow = w(6)
  const priceAnchor = fut.length > priceWindow ? fut[fut.length - priceWindow]?.close_price : undefined
  const priceVote =
    Number.isFinite(fLast?.close_price) && Number.isFinite(priceAnchor) && Math.abs(priceAnchor ?? 0) > 0
      ? Math.sign((fLast!.close_price! - priceAnchor!) / Math.abs(priceAnchor!))
      : 0
  const flowVote =
    Number.isFinite(fr3) && Math.abs((fr3 ?? 1) - 1) >= 0.05 ? Math.sign((fr3 ?? 1) - 1) : 0
  const oiVote =
    Number.isFinite(oiDeltaPct3) && Math.abs(oiDeltaPct3!) >= 0.3 ? Math.sign(oiDeltaPct3!) : 0
  const premVote =
    Number.isFinite(premBps) && Math.abs(premBps!) >= 3 ? Math.sign(premBps!) : 0
  const directionVotes = [priceVote, flowVote, oiVote, premVote].filter(v => v !== 0)
  const directionScore = directionVotes.reduce((sum, v) => sum + v, 0)
  const trendConsistency =
    directionVotes.length > 0 ? Math.min(1, Math.abs(directionScore) / directionVotes.length) : 0
  let regimeBias: ScalperFlags['regimeBias'] = 'neutral'
  if (directionScore > 0.5) regimeBias = 'long'
  else if (directionScore < -0.5) regimeBias = 'short'

  const flowDeviation = Math.abs((fr3 ?? 1) - 1)
  const oiAbs = Math.abs(oiDeltaPct3 ?? 0)
  const premiumAbs = Math.abs(premBps ?? 0)
  const volumeAbs = Number.isFinite(volumeZ) ? Math.abs(volumeZ) : 0
  const chopRisk =
    volatilityState === 'low' &&
    trendConsistency < 0.5 &&
    flowDeviation < 0.08 &&
    oiAbs < 0.5 &&
    premiumAbs < 5 &&
    volumeAbs < 0.7
  let regimeTag: ScalperFlags['regimeTag'] = 'transition'
  if (chopRisk) {
    regimeTag = 'balance'
  } else if (trendConsistency >= 0.6 && volatilityState !== 'low') {
    regimeTag = 'trend'
  }

  // Data freshness guards — INTERVAL-AWARE. Bars are keyed by OPEN time, so
  // "fresh" means the latest bar opened within one bar interval (+30min data
  // lag slack). The old fixed 20-minute guard was written for 15m bars; on 4h
  // bars it was false nearly every cycle, which permanently zeroed the
  // strong-flow flags and told the LLM its data was stale (min-size override,
  // depressed conviction) when the series was perfectly healthy.
  const now = Date.now()
  const FRESH_SLACK_MS = 30 * 60 * 1000
  const seriesIntervalMs = (arr: { timestamp: number }[]): number => {
    if (arr.length >= 2) {
      const d = arr[arr.length - 1].timestamp - arr[arr.length - 2].timestamp
      if (Number.isFinite(d) && d > 0) return d
    }
    return 60 * 60 * 1000 // fallback: current 1h feed (CoinGlass Standard)
  }
  const fresh = (ts: number | undefined, ms: number) => !!ts && (now - ts <= ms)
  const futFresh = fresh(fLast?.timestamp, seriesIntervalMs(fut) + FRESH_SLACK_MS)
  const spotFresh = fresh(last(spot)?.timestamp, seriesIntervalMs(spot) + FRESH_SLACK_MS)
  
  // Post-funding cooldown (first 30 min after 00/08/16 UTC)
  const utc = new Date(now)
  const hour = utc.getUTCHours()
  const minute = utc.getUTCMinutes()
  const isFundingBoundaryHour = (hour % 8) === 0
  const nearFundingRoll = isFundingBoundaryHour && minute <= 30

  // Options quick features (BTC/ETH only; safe if missing)
  const oLast = last(opt)
  
  // Options freshness guard (30 minutes)
  const optFresh = !!oLast && (now - (oLast.timestamp ?? 0) <= 30 * 60 * 1000)
  
  const ivDelta = optFresh && Number.isFinite(oLast?.dvol_close as number) && Number.isFinite(oLast?.dvol_open as number)
    ? (oLast!.dvol_close! - oLast!.dvol_open!)
    : NaN

  // gamma terciles (only if options are fresh)
  const gammaHist = takeLast(opt, histWindow).map(b => b.gamma_dollars ?? NaN).filter(Number.isFinite) as number[]
  let gammaTercile: ScalperFlags['gammaTercile'] = 'na'
  let gammaHi = false, gammaLo = false
  if (optFresh && gammaHist.length >= 12) {
    const t1 = quantile(gammaHist, 1/3)
    const t2 = quantile(gammaHist, 2/3)
    const g = oLast?.gamma_dollars ?? NaN
    if (Number.isFinite(g)) {
      gammaTercile = g <= t1 ? 'low' : g >= t2 ? 'high' : 'mid'
      gammaHi = g >= t2
      gammaLo = g <= t1
    }
  }

  const flags: ScalperFlags = {
    flowRatio3: Number.isFinite(fr3) ? fr3 : null,
    flowRatio5: Number.isFinite(fr5) ? fr5 : null,
    spotFlowRatio3: Number.isFinite(sfr3) ? sfr3 : null,
    oiDeltaPct3: Number.isFinite(oiDeltaPct3) ? oiDeltaPct3 : null,
    premiumBps: Number.isFinite(premBps) ? premBps : null,
    premiumMedian10Bps: Number.isFinite(premMed10Bps) ? premMed10Bps : null,
    fundingRateBps: Number.isFinite(frBps) ? frBps : null,
    ivDeltaPts: Number.isFinite(ivDelta) ? ivDelta : null,
    gammaTercile,
    liqSellPctl: Number.isFinite(sellPctl) ? sellPctl : null,
    liqBuyPctl: Number.isFinite(buyPctl) ? buyPctl : null,
    volumeZScore: Number.isFinite(volumeZ) ? volumeZ : null,
    realizedRangePct: Number.isFinite(realizedRangePctRaw) ? realizedRangePctRaw : null,

    cvdNet24Usd: Number.isFinite(cvdNet24) ? cvdNet24 : null,
    spotCvdNet24Usd: Number.isFinite(spotCvdNet24) ? spotCvdNet24 : null,
    cvdPersistence12: Number.isFinite(cvdPersistence) ? cvdPersistence : null,
    cvdDivergence,

    flowBuyStrong: Number.isFinite(fr3) && fr3 >= 1.2 && volOk && futFresh,
    flowSellStrong: Number.isFinite(fr3) && fr3 <= (1/1.2) && volOk && futFresh,
    spotBuyStrong: Number.isFinite(sfr3) && sfr3 >= 1.2 && spotFresh,
    spotSellStrong: Number.isFinite(sfr3) && sfr3 <= (1/1.2) && spotFresh,
    oiUp1: Number.isFinite(oiDeltaPct3) && oiDeltaPct3! >= 1.0,
    oiUp05: Number.isFinite(oiDeltaPct3) && oiDeltaPct3! >= 0.5,
    premPos: Number.isFinite(premBps) && premBps! >= 5, // Premium noise filter: only count if |premium| ≥ 5 bps
    premNeg: Number.isFinite(premBps) && premBps! <= -5,
    ivExpanding: Number.isFinite(ivDelta) && ivDelta! >= 3,  // +3 vol pts
    ivCompressing: Number.isFinite(ivDelta) && ivDelta! <= -1, // −1 pt
    gammaHigh: gammaHi,
    gammaLow: gammaLo,
    liqSell90: Number.isFinite(sellPctl) && sellPctl! >= 90,
    liqBuy90: Number.isFinite(buyPctl) && buyPctl! >= 90,
    liqOppClusterSell: last3SellHigh >= 2,
    liqOppClusterBuy:  last3BuyHigh  >= 2,
    
    // new data quality and timing flags
    futuresFresh: futFresh,
    spotFresh: spotFresh,
    nearFundingRoll: nearFundingRoll,
    volatilityState,
    liquidityState,
    trendConsistency,
    regimeBias,
    regimeTag,
    rangeCompression,
    chopRisk,
  }

  return flags
}

/** Weighted composite score for each side (0..100). Tuned for intraday BTC/ETH scalps. */
export function computeCompositeScore(flags: ScalperFlags): CompositeScore {
  // Long score components. The former 0.15 "options" (gamma tercile) weight
  // is gone: gamma_dollars was never populated (Deribit gives us DVOL only),
  // so it sat permanently neutral — fake precision. Weight redistributed to
  // the signals that actually move.
  //
  // A missing leg is left out and the rest are renormalized. Filling flow with
  // ratio 1.0 (or spot with a permanent 0.5) made an empty CoinAnk tape look
  // like a small real edge. When every leg is present — the normal CoinGlass
  // bar — the weights are still 30/30/20/10/10 and the score matches the old
  // formula. Unknown IV stays a neutral 0.1 so alts without Deribit do not jump.
  const parts: { w: number; long: number; short: number }[] = []

  // Flow (capped at 1.8x / 0.55x). Null = feed missing, not a balanced tape.
  let flowLong = 0
  let flowShort = 0
  if (flags.flowRatio3 != null && Number.isFinite(flags.flowRatio3)) {
    const fr = flags.flowRatio3
    flowLong = clamp((fr - 1) / (1.8 - 1), 0, 1)
    flowShort = clamp((1 - fr) / (1 - 0.55), 0, 1)
    parts.push({ w: 0.30, long: flowLong, short: flowShort })
  }

  // OI
  let oiLong = 0
  let oiShort = 0
  if (flags.oiDeltaPct3 != null && Number.isFinite(flags.oiDeltaPct3)) {
    const oiUp = Math.max(0, flags.oiDeltaPct3 / 2) // 2% maps to 1.0 (cap later)
    oiLong = clamp(oiUp, 0, 1)
    oiShort = clamp(Math.max(0, -(flags.oiDeltaPct3 / 2)), 0, 1)
    parts.push({ w: 0.30, long: oiLong, short: oiShort })
  }

  // Premium (bps): + is long-friendly, − is short-friendly
  let premLong = 0
  let premShort = 0
  if (flags.premiumBps != null && Number.isFinite(flags.premiumBps)) {
    premLong = clamp(flags.premiumBps / 15, 0, 1) // +15bps ~ 1.0
    premShort = clamp(-flags.premiumBps / 15, 0, 1)
    parts.push({ w: 0.20, long: premLong, short: premShort })
  }

  // IV regime. Missing DVOL (most alts) stays the historical neutral 0.5.
  const ivLong = flags.ivCompressing ? 1 : flags.ivExpanding ? 0 : 0.5
  const ivShort = flags.ivExpanding ? 1 : flags.ivCompressing ? 0 : 0.5
  parts.push({ w: 0.1, long: ivLong, short: ivShort })

  // Spot confirm. Null spot-flow ratio means the feed has no taker print
  // (CoinAnk Plan 2, or a CoinGlass spot outage) — do not score it as 0.5.
  let spotLong = 0
  let spotShort = 0
  if (flags.spotFlowRatio3 != null && Number.isFinite(flags.spotFlowRatio3)) {
    spotLong = flags.spotBuyStrong ? 1 : flags.spotSellStrong ? 0 : 0.5
    spotShort = flags.spotSellStrong ? 1 : flags.spotBuyStrong ? 0 : 0.5
    parts.push({ w: 0.1, long: spotLong, short: spotShort })
  }

  const wSum = parts.reduce((sum, p) => sum + p.w, 0) || 1
  let longScore = Math.round(100 * parts.reduce((sum, p) => sum + (p.w / wSum) * p.long, 0))
  let shortScore = Math.round(100 * parts.reduce((sum, p) => sum + (p.w / wSum) * p.short, 0))

  if (flags.chopRisk) {
    longScore = Math.round(longScore * 0.7)
    shortScore = Math.round(shortScore * 0.7)
  }

  if (flags.liquidityState === 'thin') {
    longScore = Math.round(longScore * 0.9)
    shortScore = Math.round(shortScore * 0.9)
  }

  if (flags.regimeTag === 'trend' && flags.regimeBias !== 'neutral') {
    if (flags.regimeBias === 'long') {
      longScore = Math.round(Math.min(100, longScore * 1.1))
      shortScore = Math.round(shortScore * 0.9)
    } else {
      shortScore = Math.round(Math.min(100, shortScore * 1.1))
      longScore = Math.round(longScore * 0.9)
    }
  }

  // CVD divergence: absorption against the move — dampen the chasing side.
  if (flags.cvdDivergence === 'bearish') {
    longScore = Math.round(longScore * 0.85)
    shortScore = Math.round(Math.min(100, shortScore * 1.1))
  } else if (flags.cvdDivergence === 'bullish') {
    shortScore = Math.round(shortScore * 0.85)
    longScore = Math.round(Math.min(100, longScore * 1.1))
  }

  const driversLong: string[] = []
  if (flags.cvdDivergence === 'bullish') driversLong.push('CVD bull-div')
  if (flowLong > 0.6) driversLong.push('buy-flow')
  if (oiLong > 0.6) driversLong.push('OI↑')
  if (premLong > 0.6) driversLong.push('premium+')
  if (ivLong > 0.6) driversLong.push('IV↓')
  if (spotLong > 0.6) driversLong.push('spot-confirm')

  const driversShort: string[] = []
  if (flags.cvdDivergence === 'bearish') driversShort.push('CVD bear-div')
  if (flowShort > 0.6) driversShort.push('sell-flow')
  if (oiShort > 0.6) driversShort.push('OI↑(shorts)')
  if (premShort > 0.6) driversShort.push('premium−')
  if (ivShort > 0.6) driversShort.push('IV↑')
  if (spotShort > 0.6) driversShort.push('spot-confirm')

  return { longScore: clamp(longScore, 0, 100), shortScore: clamp(shortScore, 0, 100), driversLong, driversShort }
}

// NOTE (2026-07): the legacy rule-based makeOpeningSuggestion /
// makeWinningMonitorSuggestion / makeLosingMonitorSuggestion helpers were
// deleted — never wired into the worker (LLM prompts + validators are the
// decision path) and they had drifted from the live rules.

