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

Existing projects that already ran this file: apply `backend/migrations/rewards_volume_sync_watermarks.sql` (Dedicated-sub volume cursors on `user_rewards`) and `backend/migrations/user_notification_preferences_push_enabled.sql` (Profile master push toggle).

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

### 5. BuilderPad (optional web product)

Branded Hyperliquid **web** apps at `{slug}.builderpad.xyz`. Console is Vite `web/` on Vercel ([builderpad.xyz](https://builderpad.xyz)). Not required for Tier 1 mobile trading. Pons columns are the optional coin chapter. See [BUILDERPAD.md](./BUILDERPAD.md). Apply the incremental files if the v1 table already exists.

```text
backend/migrations/builderpad_tenants_v1.sql
backend/migrations/builderpad_tenant_order_est_fee.sql
backend/migrations/builderpad_tenant_order_reduce_only.sql
backend/migrations/builderpad_tenant_order_settlement.sql
backend/migrations/builderpad_builder_wallets.sql
backend/migrations/builderpad_imported_builder.sql
backend/migrations/builderpad_tenant_coin.sql
backend/migrations/builderpad_tenant_wizard_draft.sql
backend/migrations/builderpad_tenant_fee_history.sql
backend/migrations/builderpad_tenant_custom_domain.sql
backend/migrations/builderpad_tenant_pledge.sql
backend/migrations/builderpad_pledge_burn_of_buyback.sql
backend/migrations/builderpad_tenant_stream.sql
```

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
| `user_notification_preferences` | Master push (`push_enabled`) + system-alert / UR category opt-in |
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

### BuilderPad (optional web product)

| Table | Role |
|-------|------|
| `tenants` | Branded app: slug, catalog, fee tenths, `buyback_pct` (of fee take) / `burn_pct` (of that buyback; both 0–100 independently), `stream_twitch` (desk overlay opt-in; handle is `socials.twitch`), `builder_address` (platform preview or creator HD 1), owner Privy DID. `status=draft` = unpublished wizard (slug reserved, hidden from directory). `wizard_draft` jsonb = chapter + coin terms until publish. `coin_*` columns = Pons v2 launch on Robinhood Chain (token, curve, pair, tx, tax, recipient) written only after the backend re-read the factory record — `builderpad_tenant_coin.sql` + `builderpad_tenant_wizard_draft.sql` + `builderpad_tenant_pledge.sql` + `builderpad_pledge_burn_of_buyback.sql` + `builderpad_tenant_stream.sql` |
| `tenant_builder_wallets` | One row per creator: HD0 `trade_wallet` vs builder (`source=embedded` HD1, or `source=imported` linked MetaMask). Builder stays Standard, never unify. `provisioned` → `funded` (≥100 USDC perp + Standard) → `active` (apps use that address as `b`). `activation_fee_tx` / `activation_fee_paid_at` = $5 BuilderPad door fee (once). Apply `builderpad_builder_wallets.sql` + `builderpad_imported_builder.sql` + `builderpad_activation_fee.sql` |
| `tenant_builder_fee_history` | Append-only builder fee changes after publish. Public on tenant cards. Identity (name/logo/bio/socials/catalog) is frozen. Apply `builderpad_tenant_fee_history.sql` |
| `tenant_pledge_history` | Append-only buyback / burn pledge changes after publish. `buyback_pct` = % of builder-fee take; `burn_pct` = % of that buyback (both 0–100, independent). Not Pons on-chain buyback. Public on tenant cards. Apply `builderpad_tenant_pledge.sql` + `builderpad_pledge_burn_of_buyback.sql` |
| `tenants.custom_domain` | Creator-owned hostname (Activate only). TXT token + `custom_domain_verified_at`. Apply `builderpad_tenant_custom_domain.sql` |
| `tenant_order_attributions` | `(wallet, cloid)` / `(wallet, oid)` for orders this client placed. Snapshots `builder_address`. Place-time `notional_usd`, `est_builder_fee_usd` (`tenths/100000`), `side`, `reduce_only`. After fill join: `filled_notional_usd`, `settled_builder_fee_usd` from HL `userFills.builderFee` on `(wallet, oid)` — never cloid alone. Apply `builderpad_tenant_order_est_fee.sql` + `builderpad_tenant_order_reduce_only.sql` + `builderpad_tenant_order_settlement.sql` |

DDL: `backend/migrations/builderpad_tenants_v1.sql`. Helpers: `backend/tenants.py`. API: `/api/tenants*`. Do not attribute volume by cloid prefix alone.

Storage (not SQL): public bucket `tenant-logos`. Backend creates it on first upload (same sanitizer as [OrbCast avatars](https://github.com/LWL-OrbCast/orbcast) — magic bytes, Pillow re-encode to WebP, 2 MB). `tenants.logo_url` stores the public https URL or a pasted https link.

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

See also: [SETUP.md](./SETUP.md) · [AI_AGENTS.md](./AI_AGENTS.md) · [BANKING_UR.md](./BANKING_UR.md) · [BUILDERPAD.md](./BUILDERPAD.md)
