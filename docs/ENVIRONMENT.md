# Environment variables

Copy the templates (placeholders only — never commit real `.env` files):

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp workers/ai-agent/.env.example workers/ai-agent/.env   # optional Tier 2
```

Each file is scoped to **one deploy surface** so you can mirror Railway / EAS without guessing which vars belong where.

| File | Deploy |
|------|--------|
| `backend/.env.example` | FastAPI on Railway (or local uvicorn) |
| `frontend/.env.example` | Expo / EAS (`EXPO_PUBLIC_*`) |
| `workers/ai-agent/.env.example` | AI worker Railway service (separate from backend) |
| `web/` (`VITE_*`) | BuilderPad Vite app — Vercel → [builderpad.xyz](https://builderpad.xyz). Vars in this file under BuilderPad |

Full prose setup: [SETUP.md](./SETUP.md) · Schema: [DATABASE.md](./DATABASE.md) · Forks: [FORKING.md](./FORKING.md).

---

## Quick tiers

| Tier | Where | Minimum vars | Outcome |
|------|-------|--------------|---------|
| **1 — Core HL** | backend + frontend | Backend: `PRIVY_*`, `SUPABASE_*`, `ARBITRUM_RPC_URL`, `BRIDGE2_RELAYER_PRIVATE_KEY`. Mobile: `EXPO_PUBLIC_BACKEND_URL`, `EXPO_PUBLIC_PRIVY_*`, `EXPO_PUBLIC_ARBITRUM_RPC_URL` | Auth, DB, Bridge2, trading UI |
| **2 — AI agents** | backend **and** AI worker | Same `SUPABASE_*` + **same** `AGENT_KMS_KEY`; worker also needs `HL_BUILDER_*`, `HL_ENV`, CoinGlass/Massive, ≥1 LLM key | Control plane + execution — [AI_AGENTS.md](./AI_AGENTS.md) |
| **3 — Neobank / banking** | backend (+ Mantle RPCs on mobile) | `UR_ENV`, `UR_PARTNER_ID`, signer + relayer keys, Mantle/Arb RPCs | IBAN/card rails — [BANKING_UR.md](./BANKING_UR.md) |
| **BuilderPad** | `web/` on Vercel + backend tenant APIs | `VITE_PRIVY_APP_ID`, tenant SQL, optional `VITE_BACKEND_URL` / `BUILDERPAD_*` | Branded HL web apps at `{slug}.builderpad.xyz` — [BUILDERPAD.md](./BUILDERPAD.md). Pons coin chapter is extra |

Optional everywhere: market-data keys, demo/testnet grants, AppsFlyer, Apple review bypass.

---

## Naming notes (common confusion)

| Topic | Truth in this repo |
|-------|--------------------|
| Supabase “secret” key | Use as `SUPABASE_SERVICE_ROLE_KEY` (often displayed as `sb_secret_…`). **Never** put it in Expo. |
| Builder vars | Backend: optional `BUILDER_ADDRESS` / `BUILDER_FEE` (should match mobile). Mobile: `EXPO_PUBLIC_HL_BUILDER_ADDRESS` (+ fee) **pins** the order builder — required for forks earning their own fees (else HyperTrade hardcoded default). AI worker: **required** `HL_BUILDER_*`. |
| Demo grants | Use **`HL_TESTNET_MASTER_PK`** (signs `usdSend`). `HL_TESTNET_MASTER_AGENT_PK` is legacy and unused for grants. |
| AI dry-run | Worker reads **`FORCE_DRY_RUN`**. `DRY_RUN_DEFAULT` is **not** read by current `config.ts`. |
| `AGENT_KMS_KEY` | 32-byte hex (64 hex chars). Backend encrypts agent keys; worker decrypts — **must match**. |

---

## Backend (Railway) — used

### Required for production trading

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend DB access (**never** ship to mobile) |
| `PRIVY_APP_ID` | Verify Privy JWTs (**required** — no hardcoded default) |
| `PRIVY_APP_SECRET` | Server Privy API (wallet-ownership checks, wallet import, BuilderPad social verification — unset = tenant socials are dropped) |
| `ARBITRUM_RPC_URL` | Bridge2 relayer + deposit scan |
| `BRIDGE2_RELAYER_PRIVATE_KEY` | Hot wallet(s) for permit deposits (ETH-funded; comma-separated OK via `BRIDGE2_RELAYER_PRIVATE_KEYS`) |

### Builder (optional for demos; required for your own fees)

| Variable | Purpose |
|----------|---------|
| `BUILDER_ADDRESS` / `BUILDER_FEE` | Override HyperTrade defaults in `server.py` / `/builder-config`. Keep in sync with frontend `EXPO_PUBLIC_HL_BUILDER_*`. |
| `HIP3_ENABLED_DEXES` | Comma-separated HIP-3 perp dex names to fetch/subscribe (`xyz,io`). Unset → `xyz,io`. Does **not** auto-list every market on those dexs — catalog is still `ASSET_METADATA`. |

### Bridge2 defaults (usually fine)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HL_BRIDGE2_ADDRESS` | `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` | HL Bridge2 spender |
| `ARBITRUM_USDC_ADDRESS` | Native USDC on Arbitrum | Permit token |
| `ARBITRUM_RPC_URL_FALLBACKS` | — | Comma-separated backup RPCs |
| `ROBINHOOD_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | **Backend only** (`backend/.env` / Railway). Pons v2 reads: quote approval, `getLaunchedToken` verify. Chain id must be 4663. **Not** `web/.env` and **not** the Foundry deploy RPC (those are separate — see below) |

### Demo / testnet

| Variable | Purpose |
|----------|---------|
| `HL_TESTNET_MASTER_PK` | Signs testnet USDC grants |
| `HL_TESTNET_MASTER_ADDRESS` | Optional; derived from PK if omitted |
| `HL_TESTNET_MASTER_AGENT_PK` | Legacy — omit |
| `DEMO_GRANT_AMOUNT_USDC` / `DEMO_TRANSFER_FEE_USDC` | Defaults `100` / `1` |

### Market data (optional)

| Variable | Purpose |
|----------|---------|
| `FINNHUB_KEY`, `ALPHAVANTAGE_KEY`, `FOREXRATE_KEY` | News / fundamentals / FX |
| `ALPHA_WARMUP_SECRET` | Protects `/api/alpha/warmup-earnings` (`?secret=` or `Authorization: Bearer`) |
| `GEMINI_API_KEY` | On-demand “Ask AI” blurbs |

### Earnings cron (optional — separate Railway service)

HyperTrade prod uses a Railway **`cron-job`** service (daily) that `POST`s to the FastAPI warmup URL. That runner reads:

| Variable (on **cron-job** service) | Purpose |
|------------------------------------|---------|
| `ENDPOINT_URL` | Full warmup URL, e.g. `https://YOUR_API/api/alpha/warmup-earnings?secret=…&symbols=TSLA,…` |
| `CRON_SECRET` | Sent as `Authorization: Bearer …` |

The FastAPI app does **not** read `ENDPOINT_URL` or `CRON_SECRET`. It only checks **`ALPHA_WARMUP_SECRET`**. So either:

1. put the same value in cron `CRON_SECRET` and backend `ALPHA_WARMUP_SECRET`, and/or  
2. put that same value in the `?secret=` query on `ENDPOINT_URL`.

Also set `ALPHA_WARMUP_SECRET` (and `ALPHAVANTAGE_KEY`) on the **hypertrade-main** / FastAPI service.

### AI control plane (optional — Tier 2)

| Variable | Purpose |
|----------|---------|
| `AGENT_KMS_KEY` | Encrypt agent keys at create time (match worker) |
| `SHOWCASE_AGENT_IDS` | Public showcase agent UUIDs (comma-separated; empty/unset = no agents) |
| `COINGLASS_GLOBAL_MODE` | Align with worker house-key mode |

### AI worker (optional — Tier 2)

See [AI worker](#ai-worker-separate-railway) below and [AI_AGENTS.md](./AI_AGENTS.md).

### Neobank / UR banking (optional — Tier 3)

See `backend/.env.example` and [BANKING_UR.md](./BANKING_UR.md). Core: `UR_ENV`, `UR_PARTNER_ID`, `UR_API_SIGNER_PRIVKEY_*`, `UR_RELAYER_PRIVKEYS_*`, Mantle + Arb Sepolia RPCs.

### Ops

| Variable | Purpose |
|----------|---------|
| `APPLE_REVIEW_BYPASS` | `true` relaxes geo-fence for App Review |
| `ENVIRONMENT` | Non-`production` enables some dev-only behavior |

### BuilderPad tenants (optional)

Optional `BUILDERPAD_PUBLIC_DOMAIN` (default `builderpad.xyz`) is the apex. Live apps are `https://{slug}.{domain}`. CORS for that wildcard is in `server.py` — there is **no** `ALLOWED_ORIGINS` env var.  
Own-builder activation reuses Bridge2 + `BUILDER_ADDRESS` as the preview fallback. HD 1 must stay Standard. Web desk `b` is `tenants.builder_address`; mobile still pins `EXPO_PUBLIC_HL_BUILDER_ADDRESS` until a follow-up.

Custom domains (Activate only) need the Vercel vars below so HTTPS attaches to the Vite project.

| Variable | Purpose |
|----------|---------|
| `BUILDERPAD_PUBLIC_DOMAIN` | Optional. Apex hostname for BuilderPad (default `builderpad.xyz`). No `https://`. Live apps = `{slug}.{this}` |
| `BUILDERPAD_ACTIVATION_FEE_USDC` | Door fee on Activate (default `5`). Once per builder, Arbitrum USDC |
| `BUILDERPAD_ACTIVATION_TREASURY` | Recipient of that fee. Unset → `BUILDER_ADDRESS` |
| `BUILDERPAD_VERCEL_TOKEN` | Vercel token that can add domains to the Vite (`web/`) project. Required for HTTPS on creator hosts |
| `BUILDERPAD_VERCEL_PROJECT_ID` | That Vercel project id (or name) |
| `BUILDERPAD_VERCEL_TEAM_ID` | Optional. Team scope for the Vercel API |
| `BUILDERPAD_VERCEL_CNAME` | CNAME target shown to creators. Default `cname.vercel-dns.com` |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Optional. Twitch Helix app token for BuilderPad desk LIVE/offline. Unset → overlay still works, `live` is unknown. Not the creator’s Privy Twitch login |

After a host verifies, add `https://{host}` to Privy **Allowed origins** (same App ID). There is no public Privy API for that list. `{slug}.builderpad.xyz` is already covered by `https://*.builderpad.xyz`.

Canonical app URL is `https://{slug}.builderpad.xyz` (`BUILDERPAD_PUBLIC_DOMAIN` / `VITE_TENANT_BASE_DOMAIN`).

---

## Frontend (Expo)

Injected at build time (`EXPO_PUBLIC_*`). Prefer `.env` / EAS secrets over committed `app.json` `extra`.

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_BACKEND_URL` | FastAPI base URL |
| `EXPO_PUBLIC_PRIVY_APP_ID` / `EXPO_PUBLIC_PRIVY_CLIENT_ID` | PrivyProvider (**required**) |
| `EXPO_PUBLIC_ARBITRUM_RPC_URL` | Client Arbitrum reads |
| Mantle / Sepolia RPCs, `EXPO_PUBLIC_UR_SOURCE_CHAIN_ID` | Banking UI |
| `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID`, `EXPO_PUBLIC_SIWE_*` | External wallet connect |
| `EXPO_PUBLIC_HL_BUILDER_ADDRESS` | **Pinned** builder on orders. Forks earning fees: set in `.env` / EAS (must match backend `BUILDER_ADDRESS`). Unset → HyperTrade hardcoded default |
| `EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS` | Client fee ceiling / default (tenths bps). API may lower via rewards discount |
| `EXPO_PUBLIC_HIP3_ENABLED_DEXES` | Comma-separated HIP-3 dexes for WS/REST/openOrders (`xyz,io`). Unset → `xyz,io`. Must stay aligned with backend `HIP3_ENABLED_DEXES`. |
| `EXPO_PUBLIC_ENABLE_BANKING` | Tier-3 UI gate. Default **off**. With `BANK_KYC_PAUSED` / `BANK_SERVICE_PAUSED` in `bankKycPause.ts`: Stage 0 off / 1 SOON / 2 KYC live / 3 maintenance PAUSED — see [FORKING.md](./FORKING.md) §3 |
| `EXPO_PUBLIC_APPSFLYER_DEV_KEY` | Optional |
| `EXPO_PUBLIC_WHITEPAPER_URL` | Profile whitepaper link. Production: `https://www.hypertrade.exchange/LWL_Whitepaper.pdf` (app fallback matches this if unset) |
| `EXPO_PUBLIC_TENANT_BASE_DOMAIN` | Optional. Same hostname as `BUILDERPAD_PUBLIC_DOMAIN` (default `builderpad.xyz`). Used in share links `https://{slug}.{domain}` |
| `EXPO_PUBLIC_TENANT_PUBLIC_ORIGIN` | Legacy. If set, only the hostname is used (same as base domain) |
| `VITE_PRIVY_APP_ID` | BuilderPad Vite console (`web/`) — same App ID as mobile |
| `VITE_PRIVY_CLIENT_ID` | Optional. Privy **Web** app client (not the Expo/mobile client). Same idea as OrbCast |
| `VITE_BACKEND_URL` | BuilderPad Vite console API origin. Empty in `npm run dev` uses `/api` proxy |
| `VITE_TENANT_BASE_DOMAIN` | Optional. Same default `builderpad.xyz`. Console origin is `https://{this}`; apps are `{slug}.{this}` |
| `VITE_TENANT_PUBLIC_ORIGIN` | Legacy. If set, hostname is used as the base domain |
| `VITE_ARBITRUM_RPC_URL` | Optional. Same role as `EXPO_PUBLIC_ARBITRUM_RPC_URL` for the Vite wallet sheet (Arbitrum USDC reads). Unset → viem public RPC |
| `VITE_WALLETCONNECT_PROJECT_ID` | Optional. Your WalletConnect (Reown) Cloud project ID for Privy's `wallet_connect_qr` login entry on the web console → `config.walletConnectCloudProjectId`. Unset → Privy's shared project (rate-limited, our domains show as unverified in wallets). Alternative: set it in the Privy Dashboard instead. Allowlist `builderpad.xyz`, `www.builderpad.xyz`, `*.builderpad.xyz` on the Reown project. Not a backend var; unrelated to `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` (Expo Reown AppKit) though the same project can be reused |
| `VITE_ROBINHOOD_RPC_URL` | **`web/.env` only** (Vite prefix). Optional. Robinhood Chain (4663) RPC for Pons reads, `simulateContract`, and Privy embedded-wallet sends (`addRpcUrlOverrideToChain`). Unset → public / Privy default RPC. Must be a **Robinhood** endpoint (Alchemy `robinhood-mainnet`), not Arbitrum. Restart Vite after changing it. This is **not** the Foundry `ROBINHOOD_RPC_URL` |

### Pons Foundry (`contracts/pons-v2/`) — separate from web/backend

Three different Robinhood RPC knobs. Do not put Foundry vars in `web/.env`.

| Where | Variable | Used for |
|-------|----------|----------|
| `backend/.env` / Railway | `ROBINHOOD_RPC_URL` | FastAPI (`pons.py`) |
| `web/.env` | `VITE_ROBINHOOD_RPC_URL` | Browser Pons reads / simulate / Privy sends |
| `contracts/pons-v2/.env` **or** the shell | `ROBINHOOD_RPC_URL` | Foundry **default** (alias `robinhood` in `foundry.toml`). `forge script … --rpc-url robinhood`. Fallback if unset: `--rpc-url robinhood_public` |

Foundry loads `.env` from **`contracts/pons-v2/`** (the Foundry project root), not the repo root and not `web/`. Never commit that file. Keystore import (`cast wallet import`) is user-global — see [PONS_FORK.md](./PONS_FORK.md) §4.

**Firebase:** gitignored `GoogleService-Info.plist` / `google-services.json` — copy from `*.example`.

---

## AI worker (separate Railway)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Same project as backend |
| `AGENT_KMS_KEY` | Must match backend |
| `HL_BUILDER_ADDRESS` / `HL_BUILDER_FEE_TENTHS_BPS` | Required address; fee defaults to `30` (same as backend `BUILDER_FEE`) if unset |
| `FORCE_DRY_RUN` | `1` = force shadow for all agents (wired in worker; overrides DB `dry_run`) |
| `HL_ENV` | `mainnet` \| `testnet` |
| `COINGLASS_HOUSE_KEY` + `COINGLASS_GLOBAL_MODE=1` | Shared bar cache mode |
| `MASSIVE_API_KEY` | Equity options context |
| `OPENAI_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | House LLM providers |
| `FORCE_DRY_RUN` | `1` = shadow all agents in this process |
| `HL_WEIGHT_PER_MINUTE` | HL REST weight budget (~1100 on dedicated egress) |

---

## Deprecated / unused (safe to remove from Railway)

| Variable | Status |
|----------|--------|
| `CRON_SECRET` / `ENDPOINT_URL` on FastAPI | Not read by `server.py` — use them on a separate Railway cron service; backend gate is `ALPHA_WARMUP_SECRET` |
| `FMP_KEY` | Unused |
| `DRY_RUN_DEFAULT` | Unused by worker `config.ts` |
| `HL_TESTNET_WS_URL` | Hardcoded in frontend `hlEnv.ts` |
| `HL_TESTNET_MASTER_AGENT_PK` | Legacy for demo grants |
| `EXPO_PUBLIC_WALLET_EXPORT_URL` | Feature removed |
| `MONGO_URL` / `DB_NAME` | Stub only |
| `EXPO_PUBLIC_SUPABASE_*` | Not used by the Expo app |

Do **not** copy `EXPO_PUBLIC_*` onto the backend Railway service — set those only in Expo/EAS.

---

## Security reminders

- Never commit `.env`, relayer private keys, or Supabase service_role / secret key
- Never embed `SUPABASE_SERVICE_ROLE_KEY` or `PRIVY_APP_SECRET` in the mobile app
- Fund relayers with **minimal** gas; rotate if leaked
- Use separate Privy apps for dev vs production

See [SECURITY.md](../SECURITY.md).
