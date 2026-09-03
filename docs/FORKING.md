# Forking HyperTrade

Practical checklist for builders (and coding agents) who want their own HL mobile app.
Start from **Tier 1**. AI (Tier 2) and neobank/banking (Tier 3) are optional.

Also read: [AGENTS.md](../AGENTS.md) · [SETUP.md](./SETUP.md) · [DATABASE.md](./DATABASE.md) · [HL_BUILDER.md](./HL_BUILDER.md)

---

## 1. Minimal fork (Tier 1 only)

Goal: Privy login → Bridge2 deposit → trade with **your** builder fee.

1. Clone; copy `backend/.env.example`, `frontend/.env.example`, and (optional AI) `workers/ai-agent/.env.example`.
2. Supabase: run **only** `backend/supabase_schema.sql` ([DATABASE.md](./DATABASE.md)).
3. Replace identity / secrets:
   - New Privy app (App ID + Client ID) — still hardcoded in `frontend/src/providers/AuthContext.tsx` until env migration; also set backend `PRIVY_APP_ID`.
   - New Supabase project URL + **service_role** key.
   - New Arbitrum RPC; new Bridge2 relayer EOA + ETH for gas.
4. **Builder fees:** orders use a **client-pinned** builder address. Defaults are the HyperTrade reference builder. To earn fees on your own code:
   - Set `EXPO_PUBLIC_HL_BUILDER_ADDRESS` (and usually `EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS`) in `frontend/.env` **and** EAS environment variables for release builds
   - Set matching backend `BUILDER_ADDRESS` / `BUILDER_FEE`
   - If using AI: set worker `HL_BUILDER_*` to the same address
   - Or replace the hardcoded defaults in `server.py` / `hyperliquid.ts` / `BuilderConfigProvider.tsx`
   - Register your builder on HL either way  
   Details: [HL_BUILDER.md](./HL_BUILDER.md) · [ENVIRONMENT.md](./ENVIRONMENT.md).
5. Branding: app name / bundle IDs in `frontend/app.json`, icons, scheme. Put RPC URLs, Privy IDs, AppsFlyer, etc. in `.env` — not in committed `app.json` `extra`.
6. Firebase: copy `*.example` → real plist/json (gitignored).
7. Smoke test: [SETUP.md](./SETUP.md) Tier 1 checklist.

You do **not** need UR partner credentials or an AI worker for this path.

HIP-4 outcome / prediction markets are **not** in this repo. Use **[LWL-OrbCast/orbcast](https://github.com/LWL-OrbCast/orbcast)** (own docs + setup). Do not merge HIP-4 UI into a HyperTrade fork unless you are deliberately combining products.

---

## 2. Skip / strip AI agents (Tier 2)

| Skip | Path / note |
|------|-------------|
| AI SQL | All `backend/migrations/ai_agents_*.sql` |
| Control plane | `backend/ai_agents.py`, `/api/ai-agents*` in `server.py` |
| Worker | Do not deploy `workers/ai-agent` |
| Showcase | `showcase/`, `/api/showcase/*` |
| App UI | `frontend/app/ai-agents.tsx`, portfolio bot badges / FAQ that assume agents |

If you **do** keep AI: [AI_AGENTS.md](./AI_AGENTS.md).

---

## 3. Skip / strip neobank / UR banking (Tier 3)

### Partner reality (important)

To offer **IBAN / Mastercard** (neobank-style rails) you need an **active UR partner ID** from UR (Fiat24).

- Onboarding is always **manual communication with the UR team** (not self-serve for production partner activation). Crypto on–off ramps may be paused while fiat / FX / P2P still work — check [@Fiat24Official](https://x.com/Fiat24Official) and [BANKING_UR.md](./BANKING_UR.md).
- Commercial terms, fees, and technical steps **may change**.
- Latest docs + sandbox: **[https://docs.ur.app/](https://docs.ur.app/)**.
- **Card Mode:** this repo implements **Fiat Only** (`MSTD` — card spends UR fiat balance), not **Crypto Backed** (`MSTC` — Prefund + auth callback). Confirm Fiat Only with UR when you onboard; see [BANKING_UR.md](./BANKING_UR.md).

If you do not have partner credentials, stay on **Stage 0** below (do not apply `ur_banking_v1.sql`).  
When you enable banking: [BANKING_UR.md](./BANKING_UR.md).

### Banking rollout stages (builders)

Three switches control what users see:

| Switch | Where | Default |
|--------|--------|---------|
| `EXPO_PUBLIC_ENABLE_BANKING` | Expo `.env` / EAS (`frontend/src/lib/bankingEnabled.ts`) | **`false`** (unset = off) |
| `BANK_KYC_PAUSED` | Code constant in `frontend/src/lib/bankKycPause.ts` | **`true`** in this repo today |
| `BANK_SERVICE_PAUSED` | Same file | **`false`** |

**SOON badge** = Stage 1 (`BANK_KYC_PAUSED`). **PAUSED badge** = Stage 3 (`BANK_SERVICE_PAUSED` wins if both are true). Stage 3 is for a store-listed banking product that is temporarily closed (maintenance) — not “coming soon.”

| Stage | Flags | What builders get | Typical use |
|-------|--------|-------------------|-------------|
| **0 — Off** | `ENABLE_BANKING=false` (or unset) | No Bank tab (nav shows **Wallet** → `/profile`). No bank balance tile, no Via Bank deposit, no IBAN/card fee rows, no Cash rewards tab/milestones. Guest bank marketing is not the entry point. | Trading-only fork; no UR partner yet |
| **1 — Visible + SOON** | `ENABLE_BANKING=true` **and** `BANK_KYC_PAUSED=true` **and** `BANK_SERVICE_PAUSED=false` | Bank tab + guest/bank marketing screens visible. Bottom-nav **SOON** badge. Users can browse the pitch and join the waitlist / email capture — **not** full country → Start KYC. | Preparing UR integration; want demand signal before KYC is live |
| **2 — KYC live** | `ENABLE_BANKING=true` **and** `BANK_KYC_PAUSED=false` **and** `BANK_SERVICE_PAUSED=false` | Full path: region/country selection → Start KYC (when region allows) → Sumsub / UR onboarding. Partner env + SQL required. | Ready for real users to verify |
| **3 — Maintenance pause** | `ENABLE_BANKING=true` **and** `BANK_SERVICE_PAUSED=true` (set `BANK_KYC_PAUSED=false` if you already launched) | Bank tab stays. Bottom-nav **PAUSED** badge. Guest page banner + Follow on X. New KYC blocked. Funds rails stay if KYC was already live. | Temporary partner/maintenance outage after Play Store listing |

Stage **0** hides banking UI entirely. Stages **1–3** keep banking code in the tree — flip flags (+ UR credentials for stage 2) without stripping files.

Rebuild the Expo client after changing `EXPO_PUBLIC_*`. Changing `BANK_KYC_PAUSED` / `BANK_SERVICE_PAUSED` is a code edit + rebuild (not an env var today).

Helper files: `bankingEnabled.ts`, `bankKycPause.ts`.

### What to skip in a Tier 1 / Stage 0 fork

| Skip | Path / note |
|------|-------------|
| UR SQL | `backend/migrations/ur_banking_v1.sql` |
| UR backend helpers | `backend/ur_*.py`, UR routes/webhooks in `server.py` |
| Banking UI | Leave `EXPO_PUBLIC_ENABLE_BANKING` unset/`false` (Stage 0). Optional deeper strip: `frontend/app/bank*.tsx`, `frontend/src/components/bank/`, `frontend/src/lib/ur*.ts`, `UrAccountProvider` |
| Sumsub / KYC native bits | Only needed for Stage 2 |

You can leave banking files in the tree unused — Stage 0 is the preferred hide so users never hit half-wired screens.

---

## 4. Optional ops

- `backend/migrations/app_version_policy_v1.sql` — update banner; edit seeded store URLs/versions or leave `enabled = false`.

---

## 5. Rebranding checklist

- [ ] `frontend/app.json` — name, slug, scheme, iOS/Android package IDs
- [ ] Icons / splash / notification icon under `frontend/assets/`
- [ ] Privy dashboard allowlists / bundle IDs
- [ ] Backend CORS / allowed origins if you expose a web showcase
- [ ] Rewards copy / referral branding (if you keep rewards)
- [ ] Remove or replace HyperTrade marketing URLs in committed `app.json` `extra` (OSS hygiene — see ROADMAP)

---

## 6. Mainnet vs demo

- Demo switches HL to **testnet** via `frontend/src/lib/hlEnv.ts`.
- Optional backend grants: `HL_TESTNET_MASTER_PK` + `demo_funding` table.
- Neobank / UR banking is **not** replaced by HL demo mode — partner rails stay separate.

Details: [HL_BUILDER.md](./HL_BUILDER.md).

---

## 7. Catalog / niche asset set

HyperTrade does **not** auto-list every HL or HIP-3 market. To add or remove tickers (core crypto vs XYZ / EntropyIO / other HIP-3), follow **[Listing a new asset](./HL_BUILDER.md#listing-a-new-asset-builder-checklist)** — backend `CRYPTO_METADATA` / `ASSET_METADATA` (optional `dex`, default `xyz`), logos, home order, optional Supabase fundamentals. Subscribe/fund dexes are `HIP3_ENABLED_DEXES` / `EXPO_PUBLIC_HIP3_ENABLED_DEXES` (default `xyz,io`); catalog allowlist is separate so `io:SNDK` cannot replace `xyz:SNDK`.

## 8. Suggested niche forks

Keep HL signing + deposits + builder config; drop the rest:

- Single asset class (e.g. gold / one HIP-3 deployer)
- Regional language pack only
- Testnet education app (demo mode)
- Trading-only (no rewards, no banking, no AI)

---

## 9. Tooling for faster forks

Coding agents work better with docs MCPs (Privy, HL, UR, Expo, Supabase, Railway, …).  
Copy-paste config and notes: **[AGENTS.md](../AGENTS.md)** → “Recommended MCP servers”.
