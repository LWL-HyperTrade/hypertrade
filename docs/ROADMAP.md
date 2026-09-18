# Roadmap

What is **shipped** in this reference app vs what we plan next.  
Tiers: **1 = Core HL** · **2 = AI agents** · **3 = Neobank / UR banking**.  
**BuilderPad** is a separate optional **web** product in this repo (`web/` → [builderpad.xyz](https://builderpad.xyz)), not a fourth mobile tier.  
Fork guides: [FORKING.md](./FORKING.md).

---

## Shipped

### Tier 1 — Core HL

- Mobile trading (perps, spot, HIP-3) with builder fee on orders
- Privy embedded wallets (user holds keys)
- Bridge2 gasless USDC deposits (Arbitrum permit + backend relayer)
- Local HL agent key (SecureStore) for fast signing
- FastAPI + Supabase (alerts, push tokens, rewards, deposit scan)
- Demo / HL testnet mode for review & onboarding
- Multi-locale UI (11 languages)

### BuilderPad (optional web product)

Shipped. Not a mobile-tier item and not “just a Pons fork.”

- Vite console in `web/`, deployed on **Vercel** as **[builderpad.xyz](https://builderpad.xyz)**
- Creators publish **branded Hyperliquid trading apps** at `{slug}.builderpad.xyz` (same FastAPI / Privy / Bridge2 stack as HyperTrade; own-builder activation)
- Optional **coin chapter**: Pons v2 factory fork in `contracts/pons-v2/` (Robinhood Chain 4663). Skip the contracts if you only want the HL web desk
- Product spec: [BUILDERPAD.md](./BUILDERPAD.md). Contract/deploy spec: [PONS_FORK.md](./PONS_FORK.md)

### Tier 2 — AI agents (optional)

- Shared agents on the user’s main HL wallet, and Dedicated agents on HL sub-accounts
- Control plane (`/api/ai-agents*`) + Railway worker (`workers/ai-agent`)
- Reasoning logs, shadow/dry-run, public `showcase/`
- **Today: one symbol per agent** (multi-symbol capped until portfolio awareness ships)

### Tier 3 — Neobank / UR banking (optional)

- UR.APP (Fiat24): IBAN / card, External Wallet Access, **Card Mode: Fiat Only**
- Sumsub KYC in-app (docs go to UR — not stored on our servers)
- Mantle fiat tokens, pay-in / payout / card flows

Partner ID = **manual UR team onboarding**. Not required to ship a HL-only app.  
Details: [BANKING_UR.md](./BANKING_UR.md).

---

## Planned (product)

Clear next builds — not committed dates.

| # | Item | Notes |
|---|------|--------|
| 1 | **Operator growth dashboard** | Internal/admin view to track growth: AI agents launched, total trading volume under the builder code, UR KYC completions, UR transaction counts/volume, and related funnel metrics |
| 2 | **AI portfolio awareness (multi-symbol)** | Agents manage **multiple symbols at once** with portfolio-level awareness: conviction budget across assets, correlation / shared-beta checks, opportunity cost (“best use of capital”). Replaces today’s one-symbol cap |
| 3 | **HL advanced order types** | Support Hyperliquid **TWAP** and **Scale** (and similar) order types in the mobile trading UX + signing path |
| 4 | **Order-related push notifications** | Push when orders fill, cancel, reject, or otherwise change state (beyond today’s price / system alerts) |
| 5 | **Codebase audit** | Third-party (or structured internal) security review of backend, relayers, wallet/signing paths, and optional UR / AI / BuilderPad modules before wider production reliance |

---

## HIP-4 outcome markets — separate repo (done)

HIP-4 (Hyperliquid outcome / prediction markets) is **not** coming into this app. It lives in its own reference so perps/HIP-3 and outcome markets stay isolated (regulatory + product).

Builders who want outcome markets: **[LWL-OrbCast/orbcast](https://github.com/LWL-OrbCast/orbcast)** — Expo + FastAPI + Vite, Privy, Bridge2, agent signing, builder fees. Docs in that repo (`README`, `docs/HIP4.md`, `docs/SETUP.md`, `docs/HL_BUILDER.md`, …). Do not add HIP-4 UI or `outcomeMeta` routes here.
