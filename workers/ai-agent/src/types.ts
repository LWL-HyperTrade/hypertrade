/** Shared row/config types mirroring backend/migrations/ai_agents_v1.sql */

import type { AgentHealth } from './lib/agentHealth.js';

/** resident = BuilderPad resident EOA (HD 2); runs like copilot without manual trades. */
export type AgentMode = 'copilot' | 'dedicated' | 'resident';
export type AgentStatus = 'draft' | 'active' | 'paused' | 'stopped' | 'revoked';

export interface AgentModelChoice {
  provider: 'openai' | 'xai' | 'gemini' | 'deepseek' | 'claude' | string;
  model: string;
}

export interface AgentConfig {
  /** HL main-dex perp coins only in V1 (no HIP-3 `dex:SYMBOL` entries). */
  symbols: string[];
  models: {
    opening: AgentModelChoice;
    monitor_win?: AgentModelChoice;
    monitor_loss?: AgentModelChoice;
  };
  /**
   * Copilot: max total notional across the agent's positions (shared balance).
   * Dedicated: USDC margin funded into the sub-account at creation. Notional
   * budget is funding × leverage_cap (enforced in the worker/adapter).
   */
  max_capital_usd: number;
  /** Optional per-position notional clamp on top of the AI's own sizing. */
  max_position_usd?: number;
  leverage_cap: number;
  /** Cross by default; the adapter falls back to isolated per-asset when HL rejects cross. */
  margin_mode?: 'cross' | 'isolated';
  /** Time structure: scalper | swing | investor. See brain/horizon.ts. */
  horizon?: 'scalper' | 'swing' | 'investor';
  /** Allowed sides (default long_short = free form). See brain/mandate.ts. */
  direction?: 'long_short' | 'long_only' | 'short_only';
  /** What success means (default active = today's behavior). long_only only for accumulate. */
  mandate?: 'active' | 'accumulate';
  /**
   * Entry appetite (default 'aggressive' via backend force). Worker may
   * effective-downgrade to 'standard' in thin hours (Fri 19:00–Sun 21:00 UTC)
   * without mutating this field. Never changes size bands, stops, or monitor
   * risk management (more positions, not bigger ones).
   */
  risk_profile?: 'standard' | 'aggressive';
  schedule_minutes?: number;
}

export interface AgentRow {
  id: string;
  privy_user_id: string;
  name: string;
  mode: AgentMode;
  status: AgentStatus;
  dry_run: boolean;
  hl_master_address: `0x${string}`;
  hl_agent_address: `0x${string}`;
  hl_agent_key_ciphertext: string;
  hl_subaccount_address: `0x${string}` | null;
  config: AgentConfig;
  coinglass_key_ciphertext: string | null;
  model_keys_ciphertext: Record<string, string> | null;
  trading_env: 'mainnet' | 'demo';
  last_run_at: string | null;
  /** Worker-written degraded hint — never overloads `status`. */
  health?: AgentHealth | null;
}

/** Why the opening model entered — fed back to the monitor prompts. */
export interface PositionThesis {
  reasoning?: string;
  invalidation_criteria?: string[];
  key_metrics?: Record<string, unknown> | null;
  add_trigger?: string | null;
  /** Entry notional — add/dca size against this so trims don't shrink pyramids. */
  opening_size_usd?: number;
  /** Successful losing-monitor DCA count (max 2). */
  dca_count?: number;
}

export interface AgentPositionRow {
  id: string;
  agent_id: string;
  symbol: string;
  dex: string;
  direction: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED' | 'CLOSED_BY_USER';
  entry_price: number;
  size_usd: number;
  leverage: number;
  stop_loss: number | null;
  take_profit: number | null;
  take_profit_targets: number[] | null;
  tp_hit_count: number;
  trim_count: number;
  checks_count: number;
  conviction: number | null;
  cloid_prefix: string | null;
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  /** See workers/ai-agent/src/lib/closeReason.ts — stop_fill | take_profit_fill | … */
  close_price: number | null;
  realized_pnl: number | null;
  last_check_at: string | null;
  thesis: PositionThesis | null;
}
