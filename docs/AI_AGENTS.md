# AI trading agents (fork guide)

Short, implementation-accurate overview for forks.  
Schema: [DATABASE.md](./DATABASE.md). Strip guide: [FORKING.md](./FORKING.md).

**Tier 2 — optional.** Builds on Core HL (Tier 1). Neobank/banking is Tier 3.

---

## What ships

Two agent **modes** (product names in the app: **Shared** and **Dedicated**). DB/API often use `mode=copilot` for Shared and `mode=dedicated` for Dedicated.

| | **Shared** (copilot) | **Dedicated** |
|---|----------------------|---------------|
| Who can use it | Everyone (default) | HL **≥ $100k** lifetime volume (or already has a sub) |
| Trades from | User’s **main** HL unified balance | Segregated **HL sub-account** |
| Isolation | Soft: `max_capital_usd` + symbol-conflict guard + cloid `0x48544149` (`HTAI`) | Hard: separate clearinghouse / book |
| Product slots / wallet | **2** | **10** (independent of Shared) |
| Funding | n/a (uses main) | Create-time fund + AI Agents Transfer sheet (Main ↔ sub) |
| App trading book | Main book | Selecting the agent switches global `activeTradingBook` to that sub |

**Dedicated plumbing (volume-gated):**

- Flags: frontend `DEDICATED_MODE_ENABLED = true`, backend `AI_AGENT_DEDICATED_ENABLED = True`
- Create: `createSubAccount` → `ensureSubAccountUnified` → `sendAsset` spot→spot fund
- Anytime: Transfer sheet (Main ↔ sub); delete does **not** auto-reclaim (API 409 if sub still holds ≥ $1)
- Unified masters: classic `subAccountTransfer` is disabled; use `sendAsset` spot↔spot (`scripts/hl-unified-subaccount-probe.mjs`). New subs often start as `"default"` — unify them so spot USDC is tradeable.

Stack:

| Piece | Role |
|-------|------|
| Mobile `app/ai-agents.tsx` | Create → approve named agent in wallet → activate; decisions UI |
| FastAPI `/api/ai-agents*` | Control plane (Privy JWT, wallet ownership checks) |
| `backend/ai_agents.py` | Config validation, AES-GCM key helpers, HL checks |
| `workers/ai-agent/` | Execution worker (Node/TS); no public HTTP |
| Supabase `ai_agent*` tables | Service-role only; RLS deny-all |
| `showcase/` | Optional public read-only demo (`SHOWCASE_AGENT_IDS` on backend) |

---

## How to enable (fork)

1. Apply AI SQL in order ([DATABASE.md](./DATABASE.md) §2).
2. Set **`AGENT_KMS_KEY`** (32-byte hex) on **both** FastAPI backend and the worker — same value. Encrypts HL agent keys (and optional BYOK ciphertexts) at rest.
3. Deploy `workers/ai-agent` (see `workers/ai-agent/Dockerfile`, `railway.toml`). Intended as **1 replica**; multi-replica is leader-gated via `worker_leader`. Prefer a **static outbound IP** so HL REST weight isn’t shared with other tenants.
4. Deploy `workers/ai-agent` as its **own** Railway (or Docker) service — not the FastAPI service. Root `Dockerfile` / `railway.toml` under `workers/ai-agent/`.

5. Worker env — **required** by `workers/ai-agent/src/config.ts` (process exits if missing):

| Var | Notes |
|-----|--------|
| `SUPABASE_URL` | Same project as main backend |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role |
| `AGENT_KMS_KEY` | 32-byte hex; **must match** backend `AGENT_KMS_KEY` (decrypts agent keys). Required in code even if omitted from a dashboard screenshot |
| `HL_BUILDER_ADDRESS` | Builder on agent orders |
| `HL_BUILDER_FEE_TENTHS_BPS` | Tenths bps (code default `30` if unset — same as backend `BUILDER_FEE`) |
| `HL_ENV` | `mainnet` or `testnet` (worker-wide; agent `trading_env` must match) |

6. House LLM keys on the **worker only** (backend does not call LLMs) — `workers/ai-agent/src/ai/executor.ts`. Set the providers you offer in the model catalog:

| Provider | Env |
|----------|-----|
| Gemini | `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` (optional if you don’t expose Claude) |

7. Other worker env commonly set in production (reference HyperTrade worker):

| Var | Role |
|-----|------|
| `COINGLASS_HOUSE_KEY` | Shared CoinGlass key for market snapshots |
| `MASSIVE_API_KEY` | Equity options context (HIP-3 paths); absent → CoinGlass-only / disclaimer |
| `HL_WEIGHT_PER_MINUTE` | HL REST weight budget (code default `600`; raise with dedicated egress) |
| `FORCE_DRY_RUN` | `1` = force shadow regardless of DB `dry_run` |
| `DRY_RUN_DEFAULT` | Present on some deploys; **not read** by current `config.ts` — prefer DB default + `FORCE_DRY_RUN` / `AI_AGENT_ALLOW_SHADOW_TOGGLE` on the API. Safe to leave unused or remove after verifying |
| `COINGLASS_GLOBAL_MODE` | `1` = house key serves all agents (optional) |
| `CYCLE_MINUTES` / `AGENT_CONCURRENCY` / `MIN_HL_BALANCE_USD` | Optional tunables (defaults in `config.ts`) |
| `MAKER_FIRST_OPEN` / `MAKER_WAIT_MS` | Opens post an ALO at the touch, wait (default 20s) polling order status, cancel, then IOC the remainder — saves the taker/maker fee gap on every maker-filled dollar. `0` = legacy IOC-only. Closes are always IOC |
| `BOOK_GATE_ENABLED` / `BOOK_MIN_DEPTH_MULT` / `BOOK_MAX_SPREAD_BPS` | Live L2 gate on fresh opens (`skipped_thin_book`): spread over the per-tier cap (BTC/ETH 15 · mid 35 · thin 80 · HIP-3 100 bps, or the global override), size not fillable inside the 3% IOC ceiling, or taking-side depth within 50 bps < `BOOK_MIN_DEPTH_MULT` (default 3) × order. Applies to shadow agents too; never to closes |
| `SIGNAL_SNAPSHOTS_ENABLED` | `0` disables `ai_signal_snapshots` writes/backfill (needs migration 8 in [DATABASE.md](./DATABASE.md)) |

### Execution path (opens)

1. **Decision-time book read** — one `l2Book` REST snapshot per symbol per cycle (weight 2, cycle-cached ≤5 min) feeds a `LIVE HL BOOK` block in the opening prompt (spread, top-5 imbalance, depth within ±10/±50 bps). Framed as execution context, not a thesis.
2. **Gate** — after sizing, a seconds-fresh snapshot decides whether the book can absorb *this* size (see env table). Logged as `skipped_thin_book` with the book fields.
3. **Maker leg** — post-only limit at best bid (long) / best ask (short) tagged with the agent cloid, bounded wait, cancel, final status read. Partial fills count.
4. **Taker leg** — IOC for the remainder, priced off the book mid (not the cycle-cached `allMids`) with a depth-aware band: worst level needed × 1.5 + 10 bps, floor 15 bps, cap 3%, one widen-retry on no-match. Static tier table (`hl/liquidityTier.ts`) is the fallback when no book is available. The IOC leg uses a sibling cloid (same agent prefix) so identity tracking is unaffected.
5. **Orphan guard** — every cycle, per symbol, resting non-trigger orders with the agent's cloid prefix are cancelled before deciding (a crash mid maker-wait must not leave an ALO that fills unattended).

### Signal calibration data

`ai_signal_snapshots` records, per symbol × bar interval × horizon per cycle, the `ScalperFlags`, composite long/short scores, HL mid, and book summary; later cycles back-fill bar-to-bar `ret_1h/4h/24h` and max favorable/adverse excursions from the CoinGlass series already fetched in Phase 1. This is the prerequisite for ever replacing the hand-set 30/30/20/10/10 composite weights with fitted ones — nothing reads it on the trade path.

8. Shadow toggle from the app requires backend `AI_AGENT_ALLOW_SHADOW_TOGGLE=1` (local/dev). New agents default `dry_run` false in DB (`ai_agents_dry_run_default_false.sql`).

---

## Scale / cost note

AI does **not** scale like the Core HL trading UI. Manual traders hit Hyperliquid from their phones; the worker shares **one egress IP** against HL’s ~1200 weight/min, plus CoinGlass / Massive / LLM spend. Plan capacity by **active agents × cycle frequency**, not app installs. Prefer **1 worker replica** + dedicated egress; see [HL_BUILDER.md — Scaling](./HL_BUILDER.md#scaling--rate-limits) and [COSTS.md](./COSTS.md).

---

## Config limits (code)

Keep in sync: `frontend/src/lib/api.ts` → `AI_AGENT_LIMITS`, `backend/ai_agents.py`.

| Limit | Value |
|-------|------:|
| Max symbols / agent | 20 |
| `max_capital_usd` | $100 – $10M |
| Min HL equity to activate / stay live | $100 |
| Optional `max_position_usd` floor | $20 |
| Max leverage cap (further clamped per asset) | 50 |
| Shared product slots / wallet | 2 (server-enforced; drafts do not count) |
| Dedicated product slots / wallet | 10 (server-enforced; independent of Shared; drafts count — HL sub created at Create) |
| Max active agents / user (`status=active`) | 12 |

**Active trading book (global):** Home AccountCard + Portfolio / asset / trade chip rows (above Trading Activity / PortfolioTabs) set `activeTradingBook` in the app store (persisted). Selecting a Dedicated agent rebinds **reads + writes** — Home balance/positions, Portfolio tabs, QuickTrade, `asset/[coin]`, `trade/[coin]` — to that HL sub via device-agent + `vaultAddress`. Main stays the signer for setup / builder / rewards (do not retarget those). Dedicated funding sheet stays Main↔sub on AI Agents (not book-scoped order plumbing). **Profile / Deposit** show Main wallet ↔ Main HL bridge via REST (do not clear the active Dedicated book — that WS retarget churn blanked Trade Balance); DepositPanel ignores Dedicated stream snapshots for Trade Balance and keeps a sticky Main total across focus hops. The single account WS (`HyperliquidAccountStreamProvider`) **retargets** to Main or the selected sub (never a second account socket); snapshots clear synchronously on book switch and consumers ignore stream frames until `subscribedUser` matches the selected book (prevents Main↔Dedicated position flash). HIP-3 JIT `sendAsset` on Dedicated uses `fromSubAccount` = sub so only that book’s spot seeds the dex. Shared-AI conflict guard is Main-only. Cold start / logout / env flip resets to Main. Deep-link: `/portfolio?book=<agentId>`.

Guards that matter for forks: symbol-conflict with user/manual positions, peer Shared agents on same master run sequentially, reconciliation of user closes (`CLOSED_BY_USER` + `close_reason`).

---

## Control-plane routes (FastAPI)

Under `/api` (Privy auth unless noted):

- `POST/GET /ai-agents`
- `POST /ai-agents/{id}/activate|pause|stop|revoke|dry-run`
- `GET /ai-agents/stats`, `/ai-agents/positions`
- `GET /ai-agents/{id}/decisions`, `/ai-agents/{id}/runs`

Showcase (separate): `GET /api/showcase/agents` driven by `SHOWCASE_AGENT_IDS`.

---

## How to disable / skip

- Do not apply `backend/migrations/ai_agents_*.sql`
- Do not deploy `workers/ai-agent`
- Do not set `AGENT_KMS_KEY` / house LLM keys
- Hide or omit `frontend/app/ai-agents.tsx` nav; leave portfolio bot badges unused

You do **not** need AI for a Tier 1 HL trading fork. This module is **Tier 2** (builds on HL); neobank/banking is Tier 3.

---

## Key files

| Area | Path |
|------|------|
| UI | `frontend/app/ai-agents.tsx`, `frontend/src/components/AiReasoningModal.tsx`, `TradingBookSwitcher.tsx` |
| Active book store | `frontend/src/lib/tradingBook.ts`, `useActiveTradingBook` |
| API client / limits | `frontend/src/lib/api.ts` (`AI_AGENT_LIMITS`) |
| Named-agent approve / sub fund | `frontend/src/lib/hyperliquid.ts` (`approveNamedAgent`, `sendAsset` helpers) |
| Backend crypto / validation | `backend/ai_agents.py` |
| Routes | `backend/server.py` (`/ai-agents*`) |
| Worker entry | `workers/ai-agent/src/index.ts`, `monitor.ts`, `hl/adapter.ts` |
| SQL | `backend/migrations/ai_agents_v1.sql` (+ follow-ups in DATABASE.md) |
