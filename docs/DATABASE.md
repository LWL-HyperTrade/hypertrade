# Database (Supabase)

How HyperTrade uses Postgres via Supabase, what a **fresh fork** must apply, and how tables map to product tiers.

Backend / workers use the **service_role** key (bypasses RLS). Most sensitive tables enable RLS with **no policies** (deny-all for anon/authenticated).

---

## Bootstrap order (fresh project)

Do this in Supabase → SQL Editor:

### 1. Core (required for Tier 1)

```text
backend/supabase_schema.sql
```

Covers: relayer locks, worker leadership, rewards/referrals, push + price alerts, Bridge2 deposit scan, demo funding, onboarding, market-data caches, RPCs used by the FastAPI backend.

Existing projects that already ran this file: apply `backend/migrations/rewards_volume_sync_watermarks.sql` (Dedicated-sub volume cursors on `user_rewards`).

### 2. AI agents (optional — Tier 2)

Apply **in this order** (later files are additive `ALTER`s / functions):

| Order | File |
|------:|------|
| 1 | `backend/migrations/ai_agents_v1.sql` — tables + `global_context_cache` + deny-all RLS |
| 2 | `backend/migrations/ai_agents_dry_run_default_false.sql` |
| 3 | `backend/migrations/ai_agents_v3_position_thesis.sql` — `ai_agent_positions.thesis` |
| 4 | `backend/migrations/ai_agents_v4_risk_profile_column.sql` — generated `risk_profile` |
| 5 | `backend/migrations/ai_agents_health_column.sql` — `ai_agents.health` |
| 6 | `backend/migrations/ai_agents_activate_under_cap.sql` — `activate_ai_agent_under_cap()` RPC |
| 7 | `backend/migrations/ai_agents_close_reason_labels.sql` — comments only |
| 8 | `backend/migrations/ai_signal_snapshots.sql` — `ai_signal_snapshots` (per-cycle flags/score/book + back-filled forward returns; calibration data, no trade-path reads). Optional: worker logs a warning and continues if absent, or set `SIGNAL_SNAPSHOTS_ENABLED=0` |

Skip this entire block if you are not shipping AI agents.

### 3. Neobank / UR banking (optional — Tier 3)

```text
backend/migrations/ur_banking_v1.sql
```

Creates: `ur_links`, `ur_webhook_events`, `ur_jobs`, `ur_notifications`, `ur_p2p_recipients` (incl. KYC mirror columns on `ur_links`).

Optional follow-up for **older** DBs that already had `ur_links` without KYC cols:

```text
backend/migrations/ur_links_add_kyc_mirror_columns.sql
```

Skip this block if you are not shipping banking.

### 4. Ops (optional)

```text
backend/migrations/app_version_policy_v1.sql
```

In-app update banner (`android` / `ios` rows). Seeds disabled placeholders — replace store URLs/versions for your fork.

---

## Table map by tier

### Tier 1 — Core HL / app ops

| Table | Role |
|-------|------|
| `relayer_lock` | Mutex for Bridge2 / permit relayer (multi-replica) |
| `worker_leader` | Leader election for background loops (alerts, AI worker, etc.) |
| `used_signatures` | Replay guard for signed payloads |
| `user_rewards` | Points, tier, HL volume + `lifetime_cash_volume_usd` + `volume_sync_watermarks` (master + owned Dedicated sub fill cursors) |
| `cash_reward_events` | Idempotent UR cash → rewards credits |
| `point_transactions` | Points ledger |
| `referrals` | Referral graph |
| `pending_trade_syncs` | Async HL volume sync queue |
| `push_tokens` | Expo push tokens (Privy `user_id`) |
| `price_alerts` / `alert_history` | User price alerts |
| `user_notification_preferences` | System-alert opt-in |
| `system_alerts_log` / `system_alert_price_snapshots` | BTC/GOLD style blast alerts |
| `transfer_rate_limits` | Transfer abuse limits |
| `deposit_scan_cursor` / `deposit_notifications_log` | Bridge2 deposit scanner |
| `demo_funding` | One-shot HL testnet grants |
| `user_onboarding` | Guide / bank / card interest flags |
| `earnings_cache`, `crypto_metadata`, `stock_fundamentals`, `asset_descriptions`, `news_cache`, `forex_rates_cache` | Market-data caches |

**Listing a new ticker:** allowlist in `server.py` first (`CRYPTO_METADATA` / `ASSET_METADATA`), then add rows here for detail/mcap — `crypto_metadata` (`description`, `coingecko_id`, often manual `circulating_supply`) and `stock_fundamentals` (`description`, `sector`, `industry`, often manual `outstanding_shares`). Full checklist: [HL_BUILDER.md — Listing a new asset](./HL_BUILDER.md#listing-a-new-asset-builder-checklist).

Defined in `backend/supabase_schema.sql`.

### Tier 2 — AI agents (optional)

| Table | Role |
|-------|------|
| `ai_agents` | Agent instance: mode, status, encrypted HL agent key, `config` jsonb, `dry_run`, `health`, generated `risk_profile` |
| `ai_agent_positions` | Tracked positions + `thesis`, `close_reason`, cloid prefix |
| `ai_agent_decisions` | Decision + reasoning jsonb (+ optional `provider` / `model`) |
| `ai_agent_runs` | Per-cycle audit + `equity_snapshot` |
| `ai_signal_snapshots` | Per symbol×interval×horizon per cycle: `flags`, composite scores, HL mid, L2 `book`; `ret_1h/4h/24h` + `max_up/max_down` back-filled from bars on later cycles |
| `global_context_cache` | Shared TTL cache (e.g. Deribit DVOL) for the worker |

Control plane: `backend/ai_agents.py` + FastAPI routes. Execution: `workers/ai-agent/` (service role only).

### Tier 3 — Neobank / UR banking (optional)

| Table | Role |
|-------|------|
| `ur_links` | Privy DID ↔ URID (`ur_id`); optional KYC mirror cols (`chain_status`, `kyc_current_step`) — **analytics only, not authz** |
| `ur_webhook_events` | Inbound UR webhooks + idempotency (`event_id`) |
| `ur_jobs` | Off-ramp / on-ramp / FX / payout / P2P job FSM (`kind`, `status`, `idempotency_key`) |
| `ur_notifications` | In-app banking inbox (system vs transaction) |
| `ur_p2p_recipients` | Saved P2P counterparties per Privy user |

DDL: `backend/migrations/ur_banking_v1.sql`. Helpers: `backend/ur_db.py`. API: FastAPI UR routes in `server.py` (not client→Supabase).

### Ops

| Table | Role |
|-------|------|
| `app_version_policy` | Soft/force update banner (`platform`, `latest_version`, `min_version`, `store_url`) |

DDL: `backend/migrations/app_version_policy_v1.sql`.

---

## Direct client access?

**No for core product data.** The mobile app talks to FastAPI with a Privy JWT. Supabase anon key is not required for trading, banking, or AI control flows.

Exceptions to the mental model: none that forks should rely on — treat Supabase as a private backend database.

---

## Mainnet vs demo and the DB

- Demo/testnet mode is primarily an **HL endpoint + signing** switch (`frontend/src/lib/hlEnv.ts`).
- `demo_funding` rows track testnet USDC grants.
- AI agents store `trading_env` (`mainnet` \| `demo`) on `ai_agents` so a demo agent cannot be confused with a mainnet one.
- UR banking is a **mainnet / partner** concern; do not expect full banking on HL testnet.

---

## Notes

- Do **not** assume `supabase_schema.sql` alone is a full production clone — apply optional migration files for the tiers you want.
- **Single-file “full reference” bootstrap** remains a nice-to-have; the ordered list above is enough for forks.

See also: [SETUP.md](./SETUP.md) · [AI_AGENTS.md](./AI_AGENTS.md) · [BANKING_UR.md](./BANKING_UR.md)
