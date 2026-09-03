# AGENTS.md — guide for coding agents (and humans)

This repo is a **mobile-first Hyperliquid builder** reference app (Expo + FastAPI).
Read this before large edits. Prefer small, tier-aware changes.

**Not the same as** in-app AI trading agents (`workers/ai-agent`). This file is for *you* (Cursor / Claude / etc.) working on the codebase.

---

## Product tiers (decide before coding)

| Tier | Ship? | What |
|------|-------|------|
| **1 — Core HL** | Required | Privy, Bridge2 deposits, agent signing, builder fee, alerts/rewards |
| **2 — AI agents** | Optional | `/api/ai-agents*`, `workers/ai-agent`, showcase (on HL) |
| **3 — Neobank / banking** | Optional | IBAN / card via UR.APP, Sumsub KYC, Mantle fiat tokens |

Default fork path = **Tier 1 only**. See [docs/FORKING.md](./docs/FORKING.md) and [docs/ROADMAP.md](./docs/ROADMAP.md).

**HIP-4 outcome markets** are a different product: [LWL-OrbCast/orbcast](https://github.com/LWL-OrbCast/orbcast). Do not add `outcomeMeta` / outcome tickets to this tree.

---

## Read these docs first

| Doc | When |
|-----|------|
| [README.md](./README.md) | Orientation |
| [docs/SETUP.md](./docs/SETUP.md) | Local / deploy bootstrap |
| [docs/DATABASE.md](./docs/DATABASE.md) | Which SQL to run per tier |
| [docs/HL_BUILDER.md](./docs/HL_BUILDER.md) | Direct-to-HL vs backend, builder fee, demo mode |
| [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) | Env vars |
| [docs/FORKING.md](./docs/FORKING.md) | Strip modules / rebrand / builder address |
| [docs/AI_AGENTS.md](./docs/AI_AGENTS.md) | AI agents fork guide (short) |
| [docs/BANKING_UR.md](./docs/BANKING_UR.md) | Neobank / UR banking fork guide (short) |
| [docs/AI_AGENTS.md](./docs/AI_AGENTS.md) | AI agents fork guide (optional Tier 2) |
| [SECURITY.md](./SECURITY.md) | Secrets hygiene |

---

## Repo map (ownership)

```
frontend/                 Expo Router app
  app/                    Screens (trade, portfolio, bank*, ai-agents, …)
  src/lib/hyperliquid.ts  HL SDK + order signing (client)
  src/lib/hlEnv.ts        mainnet vs demo (testnet) endpoints
  src/providers/          Privy, builder config, UR account, …
  src/components/bank/    UR neobank / banking UI (Tier 3)
backend/
  server.py               FastAPI entrypoint (large but sectioned — see below)
  ai_agents.py            AI control-plane helpers (Tier 2)
  ur_db.py / ur_*.py      UR banking helpers (Tier 3)
  rewards.py              Rewards / referrals
  supabase_schema.sql     Tier 1 DB bootstrap
  migrations/             AI, UR, app_version_policy SQL
workers/ai-agent/         AI execution worker (Tier 2, no public HTTP)
showcase/                 Public AI agents demo site (Tier 2)
docs/                     Human + agent documentation
```

### `server.py` orientation (do **not** read the whole file)

`backend/server.py` is a **big single FastAPI module** (~18k lines). That is intentional for this reference app, not a sign the project is unfinished. Heavy logic already lives in helpers (`ur_*.py`, `ai_agents.py`, `rewards.py`, …); `server.py` is mostly routes + wiring.

**Do not open it top-to-bottom.** Jump by section banner (search in the file) or by path:

| Tier | Approx. region | Search for this banner / hint |
|------|----------------|--------------------------------|
| **1 — Core HL** | Start → just above UR block (~lines 1–8705) | `/api/health`, `/api/builder-config`, Bridge2, rewards, alerts, demo, market-data |
| **3 — Neobank / UR** | Mid file (~8708–16990) | `UR (Fiat24) integration routes` · `/api/ur/` · webhooks |
| **2 — AI agents** | Near end (~16993–~18060) | `AI TRADING AGENTS` · `/api/ai-agents` |
| **Shared app shell** | Very end | CORS middleware, `ALLOWED_ORIGINS` (not tier logic) |

Optional modules are **additive**: skip the UR and AI sections entirely for a Tier 1-only fork (and skip their SQL / env — [FORKING.md](./docs/FORKING.md)).

| Concern | Hints |
|---------|--------|
| Health / builder config | `/api/health`, `/api/builder-config`, `BUILDER_ADDRESS` |
| Privy JWT | `PRIVY_APP_ID`, JWKS verify helpers |
| Bridge2 / relayer | permit deposit routes, `BRIDGE2_RELAYER_*` |
| Rewards / referrals | rewards sync, `user_rewards` |
| Alerts / push | price alerts, Expo push tokens |
| Demo / testnet grants | `demo_funding`, `HL_TESTNET_*` |
| UR banking (Tier 3) | `/api/ur/*`, webhooks → `ur_db` / `ur_api` / `ur_relayer` |
| AI agents (Tier 2) | `/api/ai-agents*` → `ai_agents.py`; execution = `workers/ai-agent` |
| Showcase | `/api/showcase/*` → `ai_agent_showcase.py` |
| App version banner | `app_version_policy` |

Frontend banking: `frontend/app/bank*.tsx`, `frontend/src/lib/urApi.ts`, `frontend/src/providers/UrAccountProvider.tsx`.  
Frontend AI: `frontend/app/ai-agents.tsx`, `frontend/src/lib/api.ts` (`AI_AGENT_*`), portfolio bot badges.

---

## Hard rules for agents

1. **Secrets** — never commit `.env`, service_role keys, relayer PKs, Privy secrets, UR partner secrets, RPC keys in `app.json`. See `SECURITY.md`.
2. **No exploit / attack tooling** — do not write exploit PoCs against HL, UR, or any live system.
3. **Tier discipline** — do not wire Tier 2/3 as required for Tier 1 “hello world.”
4. **Builder identity** — HyperTrade builder address/fee stay as hardcoded defaults; the mobile app **pins** the order builder from `EXPO_PUBLIC_HL_BUILDER_ADDRESS` (else that default). Forks set Expo/EAS + matching backend `BUILDER_ADDRESS` (or replace defaults) — see FORKING.md / HL_BUILDER.md.
5. **Privy** — `EXPO_PUBLIC_PRIVY_*` + backend `PRIVY_APP_ID` required via env (no committed app defaults).
6. **i18n** — unless the user asks otherwise, English-only string changes are enough (many locales exist).
7. **DB** — apply SQL from [DATABASE.md](./docs/DATABASE.md); do not invent tables that conflict with deny-all RLS patterns.

---

## UR.APP partner access (Tier 3 — neobank / banking)

Code in this repo is **External Wallet Access** (Account Mode) against UR, with **Card Mode: Fiat Only** (`MSTD` — spend from UR fiat balance). UR also offers **Crypto Backed** cards (`MSTC` — partner Prefund + real-time auth callback); that path is **not** what this reference implements. Details: [docs/BANKING_UR.md](./docs/BANKING_UR.md) · [UR integration guide](https://docs.ur.app/getting-started/integration-guide).

To offer **IBAN / card** (neobank-style) rails to real users you need an **active UR partner ID** (and related partner credentials), with Card Mode confirmed as Fiat Only (or you must rebuild for Crypto Backed).

- That always means **manual onboarding with the UR team** — not a self-serve “sign up and go” path for production partner credentials.
- Fees, commercial terms, and technical onboarding **can change**. Feature availability can too (e.g. crypto on–off ramps paused while fiat / FX / P2P still work) — follow [@Fiat24Official](https://x.com/Fiat24Official) and confirm with UR; details in [BANKING_UR.md](./docs/BANKING_UR.md).
- Always use the latest docs / sandbox: **[https://docs.ur.app/](https://docs.ur.app/)**  
  (Quickstart, integration modes, KYC, webhooks, sandbox.)

Until partner credentials exist, keep neobank/banking **optional** and ship Tier 1 trading only (AI Tier 2 does not require UR). Schema: `backend/migrations/ur_banking_v1.sql`.

---

## Recommended MCP servers (debugging / docs)

Configure these in your AI client (Cursor MCP settings, etc.) to speed up docs lookup and ops. Replace placeholders; **do not commit real API keys**.

```json
{
  "mcpServers": {
    "privy-docs": {
      "url": "https://docs.privy.io/mcp"
    },
    "supabase": {
      "url": "https://mcp.supabase.com/mcp?project_ref=your-project-id",
      "headers": {}
    },
    "hyperliquid-docs": {
      "url": "https://hyperliquid.gitbook.io/hyperliquid-docs/~gitbook/mcp",
      "headers": {}
    },
    "trade-xyz-docs": {
      "url": "https://docs.trade.xyz/~gitbook/mcp",
      "headers": {}
    },
    "ur-docs": {
      "url": "https://ur-docs-mcp-production.up.railway.app/mcp",
      "headers": {}
    },
    "expo-mcp": {
      "url": "https://mcp.expo.dev/mcp",
      "headers": {}
    },
    "alchemy": {
      "type": "streamable-http",
      "url": "https://mcp.alchemy.com/mcp"
    },
    "massive": {
      "url": "https://mcp.massive.com/"
    },
    "Railway": {
      "url": "https://mcp.railway.com",
      "headers": {}
    },
    "coinglass-api": {
      "type": "http",
      "url": "https://docs.coinglass.com/mcp",
      "headers": {
        "coinglassApiKey": "standard-api-key"
      }
    },
    "Reown Docs": {
      "name": "Reown Docs",
      "url": "https://docs.reown.com/mcp",
      "headers": {}
    }
  }
}
```

| MCP | Useful for |
|-----|------------|
| privy-docs | Auth / embedded wallets |
| supabase | Schema, SQL, project ops (your `project_ref`) |
| hyperliquid-docs | Builder codes, exchange APIs |
| trade-xyz-docs | HIP-3 / xyz equity perps context |
| ur-docs | Banking / KYC / webhooks ([docs.ur.app](https://docs.ur.app/)) |
| expo-mcp | Mobile build / EAS |
| alchemy | RCP provider / tx debugging |
| massive | Equity / market data (AI HIP-3 paths) |
| railway | Backend + `ai-agent-worker` deploy/logs |
| coinglass-api | Derivatives data for AI worker |
| Reown Docs | WalletConnect / External wallet if you touch that stack |

Human UR docs home: [https://docs.ur.app/](https://docs.ur.app/).

---

## Safe default tasks

- Fix Tier 1 trading / deposit / builder fee bugs
- Improve SETUP / DATABASE / env docs
- Add feature flags or UI gates so UR/AI can be hidden without deleting code
- Narrow refactors with tests around the touched path

## Avoid unless explicitly requested

- Re-adding removed third-party exchange integrations
- Desktop/web-first trading rewrite
- Folding all SQL into one mega-file without need
- Broad `server.py` splits mid-feature (prefer docs + targeted extracts)
