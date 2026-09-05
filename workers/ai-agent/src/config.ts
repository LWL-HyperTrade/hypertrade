/** Worker configuration from environment. Fail fast on missing secrets. */

import { isLiquidSymbol } from './hl/liquidityTier.js';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  /** 32-byte hex key for AES-256-GCM envelope encryption of agent/BYOK keys. */
  agentKmsKey: required('AGENT_KMS_KEY'),
  /** Builder address + default perp fee (tenths of a bp) attached to every agent order. */
  builderAddress: required('HL_BUILDER_ADDRESS'),
  // Keep default in sync with backend BUILDER_FEE (30 tenths = 3 bps = 0.03%).
  builderFeeTenthsBps: (() => {
    const n = Number(process.env.HL_BUILDER_FEE_TENTHS_BPS ?? '30');
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('HL_BUILDER_FEE_TENTHS_BPS must be a non-negative number');
    }
    return Math.floor(n);
  })(),
  /** mainnet | testnet — worker-wide; per-agent trading_env must match to run. */
  hlEnv: (process.env.HL_ENV ?? 'mainnet') as 'mainnet' | 'testnet',
  /** Minutes between scheduler cycles. 1h bars — hourly matches bar cadence. */
  cycleMinutes: Number(process.env.CYCLE_MINUTES ?? '60'),
  /**
   * Phase-1 bar catch-up: when a symbol's newest bar hasn't been emitted by
   * CoinGlass yet at the cycle boundary, re-poll that symbol for up to this
   * many minutes before letting agents decide — a slightly late decision
   * beats a missed one. 0 disables (agents decide on the previous bar).
   */
  barCatchupMaxMinutes: Math.max(0, Number(process.env.BAR_CATCHUP_MAX_MINUTES ?? '4') || 0),
  /**
   * Risk-parity sizing — % of equity risked AT THE STOP on a full-size (0.8)
   * open. Thin alts use `riskPerTradePct`; BTC/ETH + mid-liquid catalog use
   * `riskPerTradePctLiquid`. Notional = risk$ / stop-distance (vol-parity).
   */
  riskPerTradePct: Math.max(0.1, Number(process.env.RISK_PER_TRADE_PCT ?? '2') || 2),
  riskPerTradePctLiquid: Math.max(
    0.1,
    Number(process.env.RISK_PER_TRADE_PCT_LIQUID ?? '4') || 4,
  ),
  /**
   * Account-level exposure guard: agent opens/adds must keep the WALLET's
   * total perp notional ≤ this multiple of account equity. In cross/unified
   * mode the account is the real position — per-name leverage is not risk.
   */
  accountMaxLeverage: Math.max(1, Number(process.env.ACCOUNT_MAX_LEVERAGE ?? '4') || 4),
  /**
   * ISOLATED opens: target liquidation buffer (% of price) the agent tries
   * to post margin for. In isolated mode leverage only sets the buffer
   * (liq distance ≈ 1/leverage) — same notional, same PnL — so the agent
   * uses the LOWEST leverage that (a) achieves this buffer and (b) still
   * fits free margin, instead of blindly using the user's max.
   */
  isolatedLiqBufferPct: Math.max(2, Number(process.env.ISOLATED_LIQ_BUFFER_PCT ?? '10') || 10),
  /** Max agents monitored concurrently within a cycle. */
  agentConcurrency: Number(process.env.AGENT_CONCURRENCY ?? '5'),
  /** When set, treat every agent as shadow (no live writes) regardless of DB dry_run. */
  forceDryRun: process.env.FORCE_DRY_RUN === '1',
  /**
   * Bypass LLM on open positions and force this monitor action once per cycle.
   * Values: hold | add | dca | trim | exit | cut | flip (flip = close + open opposite same cycle).
   * Scope with FORCE_MONITOR_AGENT_ID / FORCE_MONITOR_SYMBOL — unset = all.
   * Remove after testing; this places real orders when dry_run is false.
   */
  forceMonitorAction: (process.env.FORCE_MONITOR_ACTION ?? '').trim().toLowerCase() || null,
  forceMonitorAgentId: (process.env.FORCE_MONITOR_AGENT_ID ?? '').trim() || null,
  forceMonitorSymbol: (process.env.FORCE_MONITOR_SYMBOL ?? '').trim().toUpperCase() || null,
  forceTrimPct: Number(process.env.FORCE_TRIM_PCT ?? '0.25'),
  forceAddSize: Number(process.env.FORCE_ADD_SIZE ?? '0.25'),
  /**
   * Optional house CoinGlass key for Phase-1 full-series fetch (1× per symbol).
   * In BYOK mode agents still must supply a valid personal key (probe) for
   * entitlement; the house key only pays for the shared snapshot.
   */
  coinglassHouseKey: (process.env.COINGLASS_HOUSE_KEY ?? '').trim() || null,
  /**
   * Global-cache mode (CoinGlass Standard house key serves ALL agents):
   * per-user CoinGlass keys are no longer required — entitlement checks and
   * user-key probes are bypassed, symbols come from every active agent.
   * Requires COINGLASS_HOUSE_KEY. Unset (BYOK) path is kept for revert.
   */
  coinglassGlobalMode: process.env.COINGLASS_GLOBAL_MODE === '1',
  /**
   * Massive (ex-Polygon.io) API key — listed US options for equity HIP-3
   * and GOLD/SILVER via GLD/SLV proxies (data/equityOptions.ts). Absent →
   * section renders a disclaimer,
   * agents trade on the CoinGlass series alone (pre-2026-07-22 behavior).
   */
  massiveApiKey: (process.env.MASSIVE_API_KEY ?? '').trim() || null,
  /**
   * HL REST weight budget for this process (HL IP limit = 1200/min).
   * Prod dedicated egress sets HL_WEIGHT_PER_MINUTE (~1100). Default stays
   * conservative for local / shared egress.
   */
  hlWeightPerMinute: Math.max(
    60,
    Number(process.env.HL_WEIGHT_PER_MINUTE ?? '600') || 600,
  ),
  /**
   * Live equity floor — keep in sync with backend MIN_HL_BALANCE_USD.
   * Below this, the worker auto-pauses the agent (no more LLM) until the
   * user tops up and resumes (activate re-checks the same floor).
   */
  minHlBalanceUsd: Math.max(
    1,
    Number(process.env.MIN_HL_BALANCE_USD ?? '100') || 100,
  ),
  /**
   * Live L2 book gate on fresh opens (hl/bookSnapshot.ts). Skips an open when
   * the spread is too wide, the size does not fit inside the IOC ceiling, or
   * taking-side depth within 50 bps is < BOOK_MIN_DEPTH_MULT × order size.
   * Closes are never gated. `BOOK_GATE_ENABLED=0` disables (book still
   * feeds the prompt + slippage band when available).
   */
  bookGateEnabled: (process.env.BOOK_GATE_ENABLED ?? '1') !== '0',
  bookMinDepthMult: Math.max(1, Number(process.env.BOOK_MIN_DEPTH_MULT ?? '3') || 3),
  /**
   * Optional global spread cap (bps) overriding the per-tier defaults in
   * hl/adapter.ts `maxSpreadBpsFor`. Unset → tier defaults.
   */
  bookMaxSpreadBpsOverride: (() => {
    const n = Number(process.env.BOOK_MAX_SPREAD_BPS ?? '');
    return Number.isFinite(n) && n > 0 ? n : null;
  })(),
  /**
   * Maker-first opens: post an ALO (post-only) at the touch, wait up to
   * MAKER_WAIT_MS polling order status, cancel, then IOC any remainder.
   * Saves the taker/maker fee gap on every filled maker leg. Closes always
   * stay IOC (exit certainty > bps). `MAKER_FIRST_OPEN=0` → legacy IOC-only.
   */
  makerFirstOpen: (process.env.MAKER_FIRST_OPEN ?? '1') !== '0',
  makerWaitMs: Math.min(
    120_000,
    Math.max(3_000, Number(process.env.MAKER_WAIT_MS ?? '20000') || 20_000),
  ),
  /**
   * Signal snapshots (ai_signal_snapshots): per symbol×interval×horizon per
   * cycle, flags + composite score + book, with forward returns back-filled
   * on later cycles. `SIGNAL_SNAPSHOTS_ENABLED=0` disables both writes.
   */
  signalSnapshotsEnabled: (process.env.SIGNAL_SNAPSHOTS_ENABLED ?? '1') !== '0',
} as const;

/** Thin alts → riskPerTradePct (2%); BTC/ETH + mid-liquid → riskPerTradePctLiquid (4%). */
export function resolveRiskPerTradePct(symbol: string): number {
  return isLiquidSymbol(symbol)
    ? config.riskPerTradePctLiquid
    : config.riskPerTradePct;
}

export function isTestnet(): boolean {
  return config.hlEnv === 'testnet';
}

/** Effective shadow mode: FORCE_DRY_RUN=1 wins over the per-agent DB flag. */
export function effectiveDryRun(agent: { dry_run: boolean }): boolean {
  return config.forceDryRun || agent.dry_run;
}
