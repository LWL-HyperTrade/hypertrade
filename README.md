# HyperTrade

Open-source reference for building a **mobile-native Hyperliquid builder app** — wallet auth, Bridge2 deposits, agent signing, builder fees, alerts, and rewards.

> **Mobile-first by design.** Most users trade on phones. This repo shows one full-featured path (multi-asset trading on Google Play). You are encouraged to fork narrower products — gold-only, regional equities, single HIP-3 ecosystem, demo/education — using the same infra patterns.

**Live app:** [HyperTrade on Google Play](https://play.google.com/store/apps/details?id=com.hypertrade.app). If Play is blocked (US / UK are geo-fenced), the APK is on [hypertrade.exchange](https://hypertrade.exchange).

---

## What this is

HyperTrade is a production-style **Expo / React Native** app with a **FastAPI** backend:

- **Hyperliquid** — perps, spot, HIP-3 deployer markets via `@nktkas/hyperliquid`
- **Privy** — embedded self-custody wallets (email, Google, Apple)
- **Bridge2** — gasless USDC deposits (EIP-2612 permit + backend relayer on Arbitrum)
- **Supabase** — alerts, rewards, push tokens, deposit workers
- **Railway** — backend hosting (Dockerfile included)

**Also in this reference app (optional for forks):** AI trading agents (`workers/ai-agent`, Tier 2) and UR.APP neobank / banking (IBAN/card, Tier 3). Neither is required to ship a Hyperliquid builder app — see [ROADMAP.md](./docs/ROADMAP.md) tiers.

**Not included:** legal advice or store approval guarantees.

---

## Architecture

```
Mobile (Expo + Privy)
    ├──► Hyperliquid API / WS     orders, account stream, builder fee
    └──► Your backend (FastAPI)
              ├──► Supabase
              ├──► Arbitrum RPC + Bridge2 relayer
              └──► Optional: Finnhub, Gemini, FX caches

Optional modules (skip in a minimal fork):
    ├──► UR.APP / Mantle          IBAN, fiat tokens, KYC, cards
    └──► ai-agent-worker          AI agent trading brain (Railway)
```

---

## Quick start

**~45 min** if you have Privy + Supabase + an Arbitrum RPC URL.

```bash
git clone https://github.com/YOUR_ORG/hyperrwa.git && cd hyperrwa

# Backend
cp backend/.env.example backend/.env   # fill in secrets
cd backend && pip install -r requirements.txt
uvicorn server:app --reload --port 8000

# Frontend (separate terminal — requires Expo dev client)
cp frontend/.env.example frontend/.env
cd frontend && npm install && npx expo start --dev-client
```

Full checklist: **[docs/SETUP.md](./docs/SETUP.md)**

Database bootstrap: **`backend/supabase_schema.sql`**, then optional migrations for AI / UR / app version policy — see **[docs/DATABASE.md](./docs/DATABASE.md)**.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [SETUP.md](./docs/SETUP.md) | Step-by-step infra setup |
| [DATABASE.md](./docs/DATABASE.md) | Supabase tables by tier + migration order |
| [FORKING.md](./docs/FORKING.md) | Strip banking/AI, rebrand, builder address |
| [AGENTS.md](./AGENTS.md) | Coding-agent map, MCPs, UR partner note |
| [AI_AGENTS.md](./docs/AI_AGENTS.md) | AI agents fork guide — Shared + Dedicated (HL subs) |
| [BANKING_UR.md](./docs/BANKING_UR.md) | Neobank / UR IBAN/card fork guide (short) |
| [HL_BUILDER.md](./docs/HL_BUILDER.md) | Builder fees, Bridge2, scaling & rate limits |
| [COSTS.md](./docs/COSTS.md) | Expected infra / AI / banking costs by tier |
| [ENVIRONMENT.md](./docs/ENVIRONMENT.md) | All env vars + unused/legacy list |
| [ROADMAP.md](./docs/ROADMAP.md) | Shipped tiers (HL / banking / AI); HIP-4 is a [separate repo](https://github.com/LWL-OrbCast/orbcast) |
| [MOBILE_RELEASE.md](./docs/MOBILE_RELEASE.md) | Play Store / App Store, D-U-N-S, compliance |
| [SECURITY.md](./SECURITY.md) | Secrets and reporting |

---

## What’s in the repo (tiers)

| Tier | Status | Need it to fork an HL app? |
|------|--------|----------------------------|
| **1 — Core HL trading** | Shipped | Yes |
| **2 — AI agents** | Shipped (`workers/ai-agent`) | No |
| **3 — Neobank / banking** (UR.APP IBAN / card) | Shipped in reference app | No |
| **HIP-4 outcome markets** | Separate repo — [orbcast](https://github.com/LWL-OrbCast/orbcast) | No — do not add here |

AI builds on HL (Tier 1). Neobank/banking is a separate partner stack (compliance + ops). Minimal forks should keep Privy + Bridge2 + builder fee only. Details: [ROADMAP.md](./docs/ROADMAP.md).

---

## Expected costs

Core HL stack can stay **under ~$500/mo** SaaS before upgrade cliffs (plus Bridge2 relayer ETH). Full reference with Expo/Privy upgrades and light extras often still **under ~$1k/mo**; AI house data (e.g. CoinGlass) and neobank/banking partner terms jump that hard. Rough check: **$1M volume × 0.1% builder fee ≈ $1,000**. Ballparks by tier: **[docs/COSTS.md](./docs/COSTS.md)**. Capacity / HL rate limits: **[docs/HL_BUILDER.md#scaling--rate-limits](./docs/HL_BUILDER.md#scaling--rate-limits)**.

---

## Mobile stores & regulation

| Store | HyperTrade status |
|-------|-------------------|
| **Google Play** | [Live](https://play.google.com/store/apps/details?id=com.hypertrade.app) — APK on [hypertrade.exchange](https://hypertrade.exchange) if Play is blocked |
| **Apple App Store** | Not live yet — Apple is strict on perps |

Going mobile means **Google and Apple review**, a **registered business + D-U-N-S** (financial-app reality), clear **non-custodial Hyperliquid interface** wording, and usually **geo / sanctions controls** (HyperTrade geo-fences the US and UK). Web-only forks can skip store org checks. Details: **[docs/MOBILE_RELEASE.md](./docs/MOBILE_RELEASE.md)** · costs: **[docs/COSTS.md](./docs/COSTS.md)**.

Geo-fence is backend-configurable for forks — see [ENVIRONMENT.md](./docs/ENVIRONMENT.md) / [MOBILE_RELEASE.md](./docs/MOBILE_RELEASE.md).

---

## Build your niche

You do **not** need to replicate our full asset list or UI. Strong fork strategies:

- Commodities only (XAU, XAG, oil)
- One geography or language
- One HIP-3 deployer vertical
- Testnet-only education app

Strip features you do not need; keep HL signing + deposits + builder config.

---

## Project layout

```
hypertrade/
├── backend/
│   ├── server.py              # FastAPI app (core + optional modules)
│   ├── ai_agents.py           # AI control plane (optional)
│   ├── supabase_schema.sql    # DB bootstrap
│   ├── migrations/            # Additive SQL (AI, UR, …)
│   └── .env.example
├── frontend/
│   ├── app/                   # Expo Router screens
│   ├── src/lib/hyperliquid.ts # HL SDK integration
│   └── .env.example
├── workers/ai-agent/          # AI execution worker (optional; has .env.example)
├── showcase/                  # Public AI agents demo site (optional)
└── docs/
```

---

## Credits

TypeScript Hyperliquid client: [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid) by [nktkas](https://github.com/nktkas).

---

## License

[MIT](./LICENSE) — see also [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Support the project

If this reference helps you ship, donations are welcome:

`0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB`

(Same address as the HyperTrade HL builder fee recipient.)

---

## Disclaimer

Reference software only. Not financial, legal, or tax advice. Users hold keys via Privy; you operate your own backend and relayer at your risk.
