# Expected costs (builders)

Rough **order-of-magnitude** monthly costs for running a HyperTrade-style fork. Prices change; treat this as expectation-setting, not a quote. Always check each vendor’s current plan.

HyperTrade’s own builder fee is configured in **tenths of a basis point** (see [HL_BUILDER.md](./HL_BUILDER.md)): **0.1% = 10 bps = `100` tenths**. Example: **$1M** monthly volume at **0.1%** ≈ **$1,000** builder fee — enough to cover a lean infra stack under ~$1k/mo. Core-only (no AI / neobank) can launch well under **~$500/mo** SaaS before gas float and store one-offs.

Scaling to many active users is a different problem from “can I boot the stack” — see [Scaling & rate limits](./HL_BUILDER.md#scaling--rate-limits) in the builder doc.

---

## Tier 1 — Core HL app (required stack)

| Service | Role | Ballpark |
|---------|------|----------|
| **Expo / EAS** | Mobile builds | ~$19 → expect ~$199 if you upgrade |
| **Railway** (FastAPI) | Backend | ~$5 hobby → expect ~$20+ when upgraded / multi-replica |
| **Supabase** | Postgres | $0 free → expect ~$25 on Pro |
| **Privy** | Embedded wallets | $0 start → expect ~$299 on growth plans |
| **Alchemy** (or similar RPC) | Arbitrum reads / Bridge2 | ~$5 → pay-as-you-go if you scale |
| **Domain** (e.g. Namecheap) | API / marketing host | Often ≤ ~$5/mo depending on TLD |
| **Vercel / Replit** (optional) | Showcase / landing | ~$20 if you use it |

**Also budget (not always a “monthly SaaS line”):**

| Item | Notes |
|------|--------|
| **Bridge2 relayer ETH** | Hot wallet gas on Arbitrum — keep a float; scales with deposit volume |
| **Play / Apple** | Play ~$25 one-time; Apple Developer ~$99/yr |
| **Business entity + D-U-N-S** | **Expect a company for mobile store** financial apps. **D-U-N-S is free**; entity formation can be low hundreds USD/GBP + annual filings. See [MOBILE_RELEASE.md](./MOBILE_RELEASE.md) |
| **Firebase / Expo push** | Usually free at small scale |
| **Finnhub / Alpha Vantage / FX / Gemini “Ask AI”** | Optional market-data & blurbs; free tiers or usage; app degrades if unset |
| **AppsFlyer / WalletConnect** | Optional; free tiers exist |

Other minor SaaS and gas will appear as you grow — overall **core is cheap relative to meaningful builder-fee volume**. Web-only forks may skip store org checks; **mobile forks of this repo should budget a company + D-U-N-S**.

---

## Tier 2 — AI agents (optional)

Builds on Tier 1 (HL orders / builder fee). Extra runtime cost:

| Cost | Notes |
|------|--------|
| **Extra Railway service** | `workers/ai-agent` is a **separate** deploy (not the FastAPI process) |
| **House LLM balances** | No fixed floor — start with ~$5–10 and top up; burn tracks agent activity / model choice |
| **CoinGlass** (market series) | ~$379/mo class of plan (expensive). Optional alternative: `ENABLE_COINANK=1` uses CoinAnk Plan 2 (~$68/mo) for crypto and Massive for HIP-3 stocks. Plan 3 (~$208) is not required |
| **Massive** (options context) | ~$29/mo class — optional; without it agents lean on CoinGlass / disclaimers |
| **Vibe-coding / Cursor / etc.** | Your own iteration cost — not runtime |

AI cost scales with **active agents and cycle frequency**, not with “app installs.” See [AI_AGENTS.md](./AI_AGENTS.md) and the scaling notes in [HL_BUILDER.md](./HL_BUILDER.md#scaling--rate-limits).

---

## Tier 3 — Neobank / banking / UR (optional)

Treat neobank rails as their **own business**: partner contracts, KYC volume, tax, and regulation often dominate infra.

Most crypto on-ramp / off-ramp / card providers charge large **setup fees** (sometimes five figures) and may add monthly minimums. **UR (Fiat24)** can onboard with **no setup fee** or a **refundable** setup fee after reaching a partner-specific KYC-user threshold — terms differ per partner; confirm with UR (always **manual** team onboarding).

Infra add-ons when you enable banking in this repo:

- Extra Mantle (+ Arb) RPC usage  
- **UR relayer** gas float (Arb ETH + Mantle MNT) — separate keys from Bridge2  
- Webhook / job volume on Railway + Supabase  

Do **not** assume neobank volume scales like “pure HL trading UI” — partner APIs and settlement rails become the bottleneck long before your Expo bill does.

---

## Launch vs scale (rule of thumb)

| Path | Monthly SaaS ballpark | Notes |
|------|----------------------|--------|
| **Core HL only** | Often **&lt; ~$500** before upgrade cliffs | Plus relayer ETH float |
| **Core + light extras** | Still often **&lt; ~$1k** | Until Privy / Expo / Railway upgrade |
| **+ AI (CoinGlass house key)** | Jumps hard | Data feed alone can dwarf the rest |
| **+ Neobank / banking** | Infra modest; **business/partner** costs dominate | |

**$1M volume × 0.1% builder fee ≈ $1,000** — useful mental model for “does infra pay for itself,” not a promise of volume.

---

## Related

- [HL_BUILDER.md — Scaling & rate limits](./HL_BUILDER.md#scaling--rate-limits)  
- [ENVIRONMENT.md](./ENVIRONMENT.md) · [SETUP.md](./SETUP.md) · [FORKING.md](./FORKING.md)  
- [MOBILE_RELEASE.md](./MOBILE_RELEASE.md) — stores, **business license / D-U-N-S**, non-custodial wording, geo-fence advice  

