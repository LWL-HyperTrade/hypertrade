# Hyperliquid builder integration

How HyperTrade attaches **builder fees** to orders, routes HL API/WS traffic, and handles **Bridge2 deposits**.

Official HL docs: [Hyperliquid Docs](https://hyperliquid.gitbook.io/hyperliquid-docs) · [Builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Expo mobile app                                            │
│  • Privy embedded EOA (user custody)                        │
│  • HL agent key in SecureStore (local signing)              │
│  • @nktkas/hyperliquid — Info + Exchange clients            │
│  • WebSocket account stream                                 │
└───────────────┬─────────────────────────┬───────────────────┘
                │ REST / WS               │ REST
                ▼                         ▼
     ┌──────────────────┐      ┌──────────────────────┐
     │ Hyperliquid L1   │      │ Your backend         │
     │ api.hyperliquid… │      │ • Privy JWT auth     │
     │ (orders, info)   │      │ • Bridge2 relayer    │
     └──────────────────┘      │ • builder-config     │
                               │ • rewards, alerts    │
                               │ • optional UR / AI   │
                               └──────────┬───────────┘
                                          │
                                          ▼
                               ┌──────────────────────┐
                               │ Supabase             │
                               └──────────────────────┘
                                          ▲
                                          │ service role
                               ┌──────────────────────┐
                               │ ai-agent-worker      │  (optional)
                               │ workers/ai-agent     │
                               └──────────────────────┘
```

### Direct to Hyperliquid (client-signed)

These hit HL REST/WS from the phone; the backend does **not** place the user's manual trades:

| Flow | Who signs | Notes |
|------|-----------|--------|
| Place / cancel / modify orders | HL agent key (SecureStore) | Builder fee field attached on orders |
| Approve agent / approve builder fee | Privy master EOA | One-time (or rare) ceremonies |
| Account / positions / mids / meta | — (info) | `@nktkas/hyperliquid` Info client |
| Fills / order updates | — (WS) | Account channel |
| Withdrawals | Master / typed data | EIP-712 to HL exchange; see `hlEnv.ts` for chain IDs |

### Via your backend

| Flow | Why backend |
|------|-------------|
| Bridge2 gasless deposit | Relayer submits `permit` + deposit; pays Arbitrum gas |
| `GET /api/builder-config` | Fee + optional rewards discount |
| Push alerts, price alerts, rewards sync | Supabase + workers; Privy JWT |
| Market-data caches | Finnhub / Gemini / FX — optional keys |
| UR banking (optional) | Partner API, webhooks, Mantle jobs — see [DATABASE.md](./DATABASE.md) |
| AI agent control plane (optional) | CRUD / activate under Privy JWT; encrypted keys in DB |
| AI agent execution (optional) | Separate `workers/ai-agent` process signs with **agent** keys from DB |

**Rule of thumb for forks:** keep “user money movement on HL” client-signed; use the backend for gas sponsorship, secrets, partner APIs, and anything that must not ship in the APK.

---

## Builder fee configuration

HL builder fees use **tenths of a basis point** (tenths bps):

- `30` tenths = 3 bps = **0.03%**
- `100` tenths = 10 bps = **0.1%**

### Backend

`backend/server.py` defaults to the **HyperTrade reference** builder. Override with env (optional):

```env
BUILDER_ADDRESS=0xYourBuilderAddress
BUILDER_FEE=30   # tenths bps
```

If unset, the hardcoded HyperTrade address/fee remain. Exposed at `GET /api/builder-config` (`address`, `fee`, optional rewards `discount`).

### Frontend (client-pinned address)

Orders attach the builder address from **app/env**, not blindly from the API:

1. Pin source: `EXPO_PUBLIC_HL_BUILDER_ADDRESS` / `EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS` (Expo `.env` or **EAS env / secrets**), else the HyperTrade hardcoded defaults in `hyperliquid.ts` / `BuilderConfigProvider.tsx`.
2. `BuilderConfigProvider` still fetches `GET /api/builder-config` for **fee discounts** (rewards). A mismatched API `address` is ignored; fee is clamped to the client default ceiling.
3. User must **approve max builder fee** once via HL `approveBuilderFee` for that pinned address.

Key files:

- `frontend/src/providers/BuilderConfigProvider.tsx`
- `frontend/src/lib/hyperliquid.ts`

**Forks that want their own fees must set the Expo vars** (or edit the hardcoded defaults). Backend `BUILDER_ADDRESS` should match the same address so `/builder-config` stays consistent.

```env
# frontend/.env  or  EAS Project → Environment variables
EXPO_PUBLIC_HL_BUILDER_ADDRESS=0xYourBuilderAddress
EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS=30    # tenths bps; 30 = 0.03% (match backend BUILDER_FEE)
```

Rebuild the native/dev client after changing `EXPO_PUBLIC_*` (they are baked in at build time).

### Fork checklist (earn your own fees)

Leaving defaults unchanged is fine for demos — fees go to the HyperTrade reference builder.

To collect fees yourself:

1. Register builder code on HL with your wallet
2. Set **frontend** `EXPO_PUBLIC_HL_BUILDER_ADDRESS` (+ optional `EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS`) in `.env` / EAS
3. Set matching backend `BUILDER_ADDRESS` / `BUILDER_FEE` (and worker `HL_BUILDER_*` if you run AI)
4. Or replace the hardcoded defaults in `server.py` / `hyperliquid.ts` / `BuilderConfigProvider.tsx`
5. Set fee ≤ your registered max fee
6. Test approval + order with builder field in exchange payload

---

## Agent wallet pattern

HyperTrade stores a **dedicated HL agent private key** in Expo SecureStore:

- User's Privy EOA remains the master account
- Agent key signs trades quickly without prompting every action
- Keys are namespaced per trading env (`mainnet` vs `demo`) in `hyperliquid.ts`

This matches HL's recommended API wallet / agent pattern for mobile.

---

## Deposits — Bridge2 on Arbitrum

Flow:

1. User holds USDC on Arbitrum (Privy EOA)
2. App builds EIP-2612 **permit** approving Bridge2 as spender
3. User signs permit in wallet
4. App sends permit + deposit intent to backend
5. Backend relayer submits on-chain tx (pays ETH gas)
6. USDC credits on Hyperliquid L1

Config:

| Piece | Location |
|-------|----------|
| Bridge2 address | `HL_BRIDGE2_ADDRESS` env or defaults in `DepositPanel.tsx` |
| Relayer key | `BRIDGE2_RELAYER_PRIVATE_KEY` (backend only) |
| Min deposit | 5 USDC (HL convention) |

---

## Withdrawals

Withdrawals are signed **client-side** with HL EIP-712 typed data and sent to HL exchange endpoint — same pattern as official SDK examples. Chain ID for withdraw signatures differs from exchange (see `hlEnv.ts`).

---

## Mainnet vs demo / testnet

| | **Mainnet** | **Demo (HL testnet)** |
|---|-------------|------------------------|
| App switch | `tradingEnv = 'mainnet'` | `tradingEnv = 'demo'` |
| Code | `frontend/src/lib/hlEnv.ts` | same |
| REST | `https://api.hyperliquid.xyz` | `https://api.hyperliquid-testnet.xyz` |
| WS | `wss://api.hyperliquid.xyz/ws` | `wss://api.hyperliquid-testnet.xyz/ws` |
| Agent keys in SecureStore | Namespaced per env | Separate namespace — do not reuse mainnet agent on testnet |
| Backend grants | — | `HL_TESTNET_MASTER_PK` + `demo_funding` table |
| Builder fees | Your registered mainnet builder | Testnet builder registration if you charge fees there |
| UR banking | Production partner rails | Not a substitute for HL demo — banking stays partner/mainnet |
| AI agents | `trading_env = 'mainnet'` on row | Can use `demo`; worker must target same HL env |

Demo mode is for **onboarding and store review**. A production fork can ship mainnet-only and omit `HL_TESTNET_*` vars.

Official builder registration: [Builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes).

---

## HIP-3 deployer assets

HyperTrade supports HIP-3 permissionless perp deployers (tradeXYZ `xyz:*`, EntropyIO `io:*`, …) alongside native HL core markets. Protocol identity is always `{dex}:{COIN}` (e.g. `xyz:SNDK`, `io:ANTH`). The app only surfaces markets you **allowlist in `ASSET_METADATA`** — HL can list a ticker on-chain and it still won’t appear until you add metadata + UI wiring below. Enabled dexs (`xyz` + `io` by default) control subscribe/fund/fetch only; they do **not** auto-list every `perpDexs` venue (Felix, cash/USDT, …). You can also **strip** deployers / categories and ship a niche catalog without changing HL signing or Bridge2.

Default enabled dexs: backend `HIP3_ENABLED_DEXES`, mobile `EXPO_PUBLIC_HIP3_ENABLED_DEXES` (comma-separated, 2–4 letter names). Unset → `xyz,io`. AI agents may trade **catalogued** `xyz:*` and `io:*` (`SUPPORTED_HIP3_DEXES`); pre-IPO / exclude lists still block names like `io:ANTH`.

---

## Listing a new asset (builder checklist)

Assume the market already exists on Hyperliquid (core crypto perp/spot, or a HIP-3 deployer market). HyperTrade then needs catalog + UI + optional fundamentals so the home list, logos, and market-cap math work.

### 1. Backend allowlist — `backend/server.py`

| Market type | Dict | Typical `category` |
|-------------|------|--------------------|
| Native HL **crypto** | `CRYPTO_METADATA` | `"crypto"` |
| HIP-3 / XYZ equities, FX, commodities, indices, etc. | `ASSET_METADATA` | `"stock"`, `"forex"`, `"commodity"`, `"index"`, … |

Minimal shape:

```python
# Crypto (core)
"KNTQ": {"name": "Kinetiq", "symbol": "KNTQ", "category": "crypto", "isSpotOnly": True},

# HIP-3 / XYZ (example stock) — omitted dex defaults to xyz
"CXMT": {"name": "ChangXin Technology", "symbol": "CXMT", "category": "stock", "icon": "💻"},

# HIP-3 / other dex (EntropyIO test listing). `dex` is required so io:SNDK
# cannot collide with xyz:SNDK.
"ANTH": {"name": "Anthropic", "symbol": "ANTH", "category": "stock", "icon": "🤖", "isPreIpo": True, "dex": "io"},
```

Useful flags / fields:

| Field | When |
|-------|------|
| `isSpotOnly: True` | Spot market only (no perp in this app catalog) — e.g. `KNTQ`, `USDT`, `GOLDSPOT` |
| `isPreIpo: True` | Pre-IPO / IPOP-style equities — UI treats them as pre-IPO; **clear the flag** once the live equity perp replaces it (see comments on `SPCX` / `CBRS`) |
| `dex` | HIP-3 perp dex (`"xyz"`, `"io"`, …). **Omitted `dex` means `xyz`.** Required when the same ticker exists on another enabled dex (do **not** let `io:SNDK` steal the Sandisk `xyz:SNDK` card). |
| `hlBaseCoin` | HL base ticker differs from app key — e.g. `GOLDSPOT` → `"XAUT"` |
| `displayName` | Home/ticker label differs from HL/API key — e.g. `CL` → `OIL`, `XYZ100` → `NDX100` |
| `icon` | Emoji fallback when no image logo |
| `category` | Drives home tabs (`stock` / `crypto` / `commodity` / `forex` / `index`) — set this deliberately |

Anything **not** in these dicts is skipped by the market assembly path (HIP-3 names that aren’t allowlisted never reach the app).

### 2. Logo — frontend

1. Add an image under `frontend/assets/images/symbols/` (webp preferred; match existing naming).
2. Register it in `frontend/src/components/AssetLogo.tsx` (`SYMBOL → require(...)` map).

Without this, users see the emoji/`icon` fallback (or a generic glyph).

### 3. Home visibility & order — `frontend/app/index.tsx`

Edit `CUSTOM_MARKET_ORDER`:

- `all` — All tab pin order  
- `stocks` / `crypto` / `commodities` / `forex` / `index` / `spot` — per-tab order  

Symbols not listed still appear (fallback rank), but pinned order is how HyperTrade curates the homepage. Spot tab also uses `CUSTOM_MARKET_ORDER.spot` as a whitelist.

Optional: `STOCK_SYMBOL_OVERRIDES` if a ticker must force `category: 'stock'` in the UI. Thin books can stay wired but hidden via `frontend/src/lib/hiddenMarkets.ts` (see `GOLDSPOT`).

### 4. “New” listings chip — `frontend/src/lib/newListings.ts`

Prepend the symbol to `NEWLY_LISTED_SYMBOLS` (newest first). The **New** sub-filter shows up to 15 matches in that order, scoped to the active parent tab.

### 5. Showcase logo (optional but easy to miss)

If you ship the public showcase site, mirror the logo there too:

1. Copy the same webp into `showcase/public/symbols/`.
2. Register in `showcase/src/lib/symbolLogos.ts` (`SYMBOL_LOGOS` map).  
   Avoid duplicate keys (TypeScript error).

### 6. AI agents — class map + HIP-3 allowlist

Skipping these does **not** hide the ticker from Home/Trade, but agents will mis-prompt or reject the symbol on create/edit.

| File | What to do |
|------|------------|
| `workers/ai-agent/src/brain/assetClass.ts` | Add HIP-3 **coin part** (no `xyz:`) to `HIP3_CLASS` — `equity` / `forex` / `commodity` / `index`. Keep in lockstep with `ASSET_METADATA`. |
| `backend/ai_agents.py` → `AI_AGENT_HIP3_EXCLUDED_COINS` | **Default: leave the new equity off this list** so agents can pick it. |
| `frontend/src/lib/aiAgentHip3Exclude.ts` | Same set — must stay identical to the backend frozenset. |

**When to put a coin on the exclude list** (not Finnhub): no usable **Massive listed-US-options** underlier / hybrid stack (or deferred FX/commodities). Examples already excluded: `PURRDAT`, `SMSN`, `BOT`, `CXMT`, FX, non-GOLD/SILVER commodities, synthetic `XYZ100`/`SP500`. DRAM/EWY/GOLD/SILVER stay allowed (ETF or GLD/SLV proxies). See [AI_AGENTS.md](./AI_AGENTS.md).

Redeploy the **ai-agent worker** after `assetClass.ts` changes (not only the API).

### 7. Finnhub fundamentals sync (stocks) — optional but separate from AI exclude

Daily sync in `backend/server.py` fills `stock_fundamentals` metrics for US-listed names. It is **independent** of the AI HIP-3 exclude list.

| Knob | When |
|------|------|
| `_FINNHUB_UNSUPPORTED` | Skip sync entirely (e.g. `SMSN` KR-only). Row may still exist from an old manual insert — it will **not** refresh. |
| `_FINNHUB_SYMBOL_MAP` | HL display key ≠ Finnhub ticker (e.g. `PURRDAT` → `PURR`). |
| `_FINNHUB_PROFILE_NAME_GUARDS` | Recycled tickers — require profile `name` substrings or sync skips (e.g. `BOT`, `SKHY`, `SPCX`). |
| `_FINNHUB_PRE_IPO` | Derived from `ASSET_METADATA.isPreIpo` — pre-IPO names are not Finnhub-synced. |

Confirm sync landed: `stock_fundamentals.fetched_at` recent + `mkt_cap` / ratios populated. Null `fetched_at` usually means manual-only row or sync skip/guard failure.

### 8. Supabase fundamentals (market detail / mcap)

Code gets the ticker onto the tape; **descriptions and mcap inputs** mostly live in Supabase.

**Stocks / HIP-3 equities** — `stock_fundamentals`:

```sql
INSERT INTO stock_fundamentals (symbol, description, sector, industry)
VALUES (
  'CXMT',
  'Short plain-language description…',
  'Technology',
  'Semiconductor'
)
ON CONFLICT (symbol) DO UPDATE SET
  description = COALESCE(stock_fundamentals.description, EXCLUDED.description),
  sector = COALESCE(stock_fundamentals.sector, EXCLUDED.sector),
  industry = COALESCE(stock_fundamentals.industry, EXCLUDED.industry);
```

Also seed **localized blurbs** in `asset_descriptions` (`symbol` + `lang`) if you use the multi-lang detail panel — EN-only still works, but other locales fall back empty.

**Crypto** — `crypto_metadata`:

```sql
INSERT INTO crypto_metadata (symbol, description, coingecko_id, max_supply, whitepaper_url)
VALUES (
  'KNTQ',
  'Short plain-language description…',
  'kinetiq',          -- CoinGecko id when available (enables supply sync)
  '1000000000',
  'https://example.com/docs'
)
ON CONFLICT (symbol) DO NOTHING;
```

### 9. Manual fields / edge cases that make mcap / cards work

These are easy to forget; the UI will look empty or wrong without them:

| Field | Table / file | Notes |
|-------|--------|--------|
| `circulating_supply` | `crypto_metadata` | Needed for crypto mcap. CoinGecko sync fills this when `coingecko_id` is set; otherwise set manually. |
| `outstanding_shares` | `stock_fundamentals` | Needed for equity mcap. Finnhub often won’t fill HIP-3 / thin names — set manually. |
| `sector` / `industry` | `stock_fundamentals` | Manual for many XYZ listings; used in detail UI. |
| `category` (code) | `CRYPTO_METADATA` / `ASSET_METADATA` | Not a Supabase column — wrong category → wrong home tab. |
| `STOCK_SYMBOL_OVERRIDES` | `frontend/app/index.tsx` | Force `category: 'stock'` when HL/meta is ambiguous. |
| `KRW_LISTED_STOCK_SYMBOLS` | `frontend/app/asset/[coin].tsx` | Only for KRW-denominated fundamentals display (e.g. `SMSN`). Do **not** add US Nasdaq names here. |
| Spot toggle | `frontend/src/lib/spotToggleWhitelist.ts` | Only if the asset has a spot book you want in QuickTrade / search spot rows. |
| Hide thin books | `frontend/src/lib/hiddenMarkets.ts` | Keep wired but invisible (see `GOLDSPOT`). |

Redeploy **backend** after dict / Finnhub edits; rebuild the app after logo / `index.tsx` / `newListings.ts` / exclude-list changes; redeploy **ai-agent worker** after `assetClass.ts`.

### Quick path by asset class

| You want to list… | Code dict | Logo + home + New | Agents | Supabase |
|-------------------|-----------|-------------------|--------|----------|
| Core crypto perp | `CRYPTO_METADATA` | `AssetLogo` + `CUSTOM_MARKET_ORDER` (+ `newListings`) | n/a (crypto path) | `crypto_metadata` (+ circ supply / CoinGecko id) |
| Crypto spot-only | same + `isSpotOnly: True` | also pin under `spot` + spot whitelist | n/a | same |
| XYZ / HIP-3 stock | `ASSET_METADATA` `stock` | same; optional `isPreIpo` | `assetClass.ts` equity; exclude only if no Massive options underlier | `stock_fundamentals` (+ shares); optional `asset_descriptions` |
| FX / commodity / index | `ASSET_METADATA` + category | pin under that tab | `assetClass.ts` + usually **exclude** (except GOLD/SILVER) | optional / as needed |

### Minimal HIP-3 equity checklist (copy/paste)

1. HIP-3 market live (`xyz:TICKER` or `io:TICKER`, …)
2. `ASSET_METADATA` entry (`category: "stock"`; set `dex` when not xyz)
3. Logo → `AssetLogo.tsx` (+ showcase `symbolLogos.ts` if needed)
4. `CUSTOM_MARKET_ORDER` (+ `STOCK_SYMBOL_OVERRIDES` / `newListings` as desired)
5. Confirm the dex is in `HIP3_ENABLED_DEXES` / `EXPO_PUBLIC_HIP3_ENABLED_DEXES` (default includes `xyz` and `io`)
6. `workers/.../assetClass.ts` → `HIP3_CLASS` (defaults to equity if omitted)
7. Decide AI: leave off exclude lists **or** add to both exclude files if no US options underlier / pre-IPO
8. Finnhub: map/guard/unsupported only if sync needs it; else rely on manual `stock_fundamentals`
9. Supabase: `stock_fundamentals` (+ `outstanding_shares`, sector/industry) and optional `asset_descriptions`
10. Deploy API + worker; rebuild app

### TradeXYZ specs (before you allowlist)

For HIP-3 / tradeXYZ markets, use the official [Specification Index](https://docs.trade.xyz/consolidated-resources/specification-index) as the source of truth for:

- Instrument ticker vs display name (e.g. `WTIOIL` / `CL` → app `OIL`, `XYZ100` → `NDX100`)
- Underlying / oracle, max leverage, discovery bounds
- Margin mode, session hours, funding multiplier
- Copy-ready **descriptions** for `stock_fundamentals` (or other detail UI)

HyperTrade’s `ASSET_METADATA` keys and `displayName` / `category` should stay consistent with that index + what HL actually returns for `xyz:*`. Specs and OI caps change — don’t hardcode leverage/sessions from memory.

See also [DATABASE.md](./DATABASE.md) for table roles.

### Stay current (API + listings + wallet SDK)

Upstream changes (new tickers, symbol renames, session rules, exchange/info API behavior, wallet SDK fixes) often require a small HyperTrade code or Supabase update. Subscribe to:

| Channel | Why |
|---------|-----|
| [Hyperliquid API Announcements](https://t.me/hyperliquid_api) (Telegram) | Breaking / additive API notes for builders |
| [HL Discord](https://discord.gg/hyperliquid) `#api-traders` | Questions + discussion (HL FAQ points API chatter here) |
| [tradeXYZ Announcements](https://t.me/tradexyz_announcements) (Telegram) | New / updated XYZ markets, sessions, product changes |
| [Privy React Native changelog](https://docs.privy.io/changelogs/react-native) | `@privy-io/expo` fixes (iOS background / wallet reconnect, etc.) |

Docs stay useful for deep dives ([HL API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api), [tradeXYZ docs](https://docs.trade.xyz/), [Privy RN](https://docs.privy.io/basics/react-native/installation)); Telegram/Discord/changelogs are how you hear about changes **before** they surprise production.

---

## HIP-4 outcome markets (separate repo)

HL HIP-4 is **outcome / prediction markets**. This HyperTrade reference stays perps / spot / HIP-3 — HIP-4 is isolated on purpose (regulatory + product).

Builders who want outcome markets: **[LWL-OrbCast/orbcast](https://github.com/LWL-OrbCast/orbcast)** (its own setup, `docs/HIP4.md`, builder-fee / Bridge2 notes). Do not wire `outcomeMeta` or outcome tickets into this app. See [ROADMAP.md](./ROADMAP.md).

---

## Scaling & rate limits

No separate “scale” doc — expectations live here. Dollar ballparks: [COSTS.md](./COSTS.md).

### Railway replicas vs relayer keys

| Lever | What it does | Launch minimum |
|-------|----------------|----------------|
| **FastAPI replicas** | Horizontal API capacity / HA | **1 is enough** for Bridge2 correctness |
| **Bridge2 relayer keys** (`BRIDGE2_RELAYER_PRIVATE_KEY(S)`) | Parallel gas sponsorship; deterministic per-user assignment + Supabase `relayer_lock` | **1 key** works; more keys help under concurrent deposits |
| **AI worker replicas** | Leader-elected; intended shape is **1** | Prefer 1 + static egress IP |

HyperTrade prod may run **multiple FastAPI replicas** (e.g. 4) for traffic headroom — that is **not** required for Bridge2 to function. Locks make multi-replica safe; they do not require multi-replica.

### Where traffic actually goes

| Path | Who hits the limit | Implication |
|------|--------------------|-------------|
| Manual trading (orders, mids, WS) | **User device → Hyperliquid** | Mostly **not** shared on your Railway IP |
| Bridge2 / transfers / alerts / rewards | **Your backend** | Scales with deposits, push, and admin traffic |
| AI agent cycles | **Worker egress IP → HL + CoinGlass + LLMs** | Shared budget across all agents |

So “~1k active app users” on a modest Core HL deploy is a **reasonable planning target** if most activity is client→HL trading and Bridge2 stays bursty. It is **not** the same as “1k concurrent AI agents” or “1k heavy banking users.”

### Hyperliquid ([official rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits))

Two separate budgets:

| Limit | Scope | What it gates |
|-------|--------|----------------|
| **IP weight** | ~1200 REST weight / minute / IP (info + exchange) | Shared egress (backend, AI worker, a self-hosted node’s outbound calls) |
| **Address actions** | Per user (subaccounts = separate); grows with cumulative traded USDC; starter buffer ~10k actions | How many **signed exchange** actions that address can send (not info) |

Also: exchange actions weigh `1 + floor(batch_length / 40)`; many info calls weigh **2** or **20** (some heavier); fills/history add weight by items returned; WS has connection / subscription / msg caps — see HL docs.

**Builder app:** each phone uses its own IP → 1k traders do not multiply into one backend HL budget.  
**AI worker:** one (or few) IPs must stay under 1200 weight/min — set `HL_WEIGHT_PER_MINUTE` (default `600`; ~1100 with dedicated egress), tune `AGENT_CONCURRENCY` / `CYCLE_MINUTES`. See [AI_AGENTS.md](./AI_AGENTS.md).

### Raising Hyperliquid headroom (optional)

HyperTrade’s default stack (phones → public HL API; one worker IP) is enough for a lean Core + light AI launch. When **you** hit walls, HL documents these upgrade paths — none are wired into HyperTrade by default:

| Lever | Helps with | Notes |
|-------|------------|--------|
| **[`reserveRequestWeight`](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#reserve-additional-actions)** | **Address-based** action limits | Pay **0.0005 USDC per reserved weight** from the perps balance instead of earning headroom only via fills. Optional `destination` can fund another existing L1 user. Useful for HFT-style or agent wallets that spam actions relative to volume. |
| **[Non-validating node](https://github.com/hyperliquid-dex/node)** (`--serve-info`) | **IP / info** pressure + trust | Permissionless node; local `http://localhost:3001/info` for a subset of info types. HL: “help with rate limits and reduces trust assumptions.” Heavy ops (CPU/RAM/disk, gossip peers). See [nodes docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes). |
| **Indexed / non-public APIs** ([HyperCore Tools → APIs](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hypercore-tools#apis)) | Heavy reads, history, gRPC/WS | Community / vendor stacks when public REST+WS is the bottleneck — e.g. [Hydromancer](https://docs.hydromancer.xyz/) (non-rate-limited APIs / indexing), [Dwellir](https://www.dwellir.com/docs/hyperliquid/grpc/) (gRPC / WS), CCXT, etc. Pick what matches your stack; HyperTrade does not depend on these. |

### Priority fees (latency, not rate limits)

Separate from IP/address quotas: HL [priority fees](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees) let you **buy better place in line with HYPE** instead of only racing infra (co-lo, peer tuning). Fees are burned. HyperTrade retail UI does **not** use these today.

| Kind | What you buy | Rough idea (see HL docs for current empirics) |
|------|----------------|-----------------------------------------------|
| **Gossip (read) priority** | Auction slots that peers may use when ordering data to your IP | `gossipPriorityBid` — bid HYPE from **spot** for an IP; ~tens of ms per slot on mainnet historically |
| **Order (write) priority** | Faster / better treatment for qualifying **IOC** or **ALO** orders | Grouping `{"p": …}` as a rate of filled (IOC) or resting (ALO) notional, charged from **undelegated stake** as HYPE; IOC also gets mempool time preference |

Worth knowing for forks that add MM bots, low-latency agents, or pro order entry. It does **not** raise the 1200 weight/min IP budget or replace `reserveRequestWeight` for action spam. Most Core HL mobile users never need it.

Fork guidance:

1. Prefer **client→HL** for user trading (already the HyperTrade shape) so IP weight stays off your servers.
2. When the **AI worker** saturates IP weight: dedicated egress, lower concurrency, then consider a **local info node** or a vendor info/index API for read-heavy paths.
3. When a **single address** (agent / bot) hits action limits: trade more, or call **`reserveRequestWeight`** — do not confuse this with the 1200/min IP budget.
4. When **latency** (not quota) is the product: consider [priority fees](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees) and/or better peering — not more FastAPI replicas.
5. Keep exchange **signing** on keys you control; nodes and third-party APIs are mainly for **data / throughput**, not a substitute for agent custody.

### Other bottlenecks that force upgrades

| Resource | Why it bites | When you feel it |
|----------|--------------|------------------|
| **Alchemy / RPC** | Bridge2 txs, deposit scan, UR chain reads | Deposit spikes / banking volume |
| **Relayer ETH (and UR MNT)** | Gas sponsorship float | Sustained gasless deposits / UR flows |
| **Supabase** | Locks, alerts, jobs, AI tables | Connection / row / realtime plan limits |
| **Privy** | Auth + wallet infra | MAU / plan tier |
| **Railway CPU/RAM** | FastAPI + background loops | Alert workers, UR jobs, concurrent HTTP |
| **Finnhub** (optional) | Backend caps ~50 calls/min | News / fundamentals refresh |
| **Alpha Vantage** (optional) | Free tier very strict; earnings cron | Daily warmup / fundamentals |
| **CoinGlass / Massive** (AI) | Vendor plan RPM + $ | Active agent count / symbols |
| **LLM providers** (AI) | $/token | Agent cycle frequency × model |
| **UR partner API** (banking) | Partner-side limits & ops | KYC + payment volume — not like HL client trading |

### Rough capacity intuition (not a guarantee)

| Surface | Modest reference-style stack | First walls |
|---------|------------------------------|-------------|
| **Core HL trading UI** | On the order of **~1k active users** is plausible | RPC + Railway + Privy plan; Bridge2 gas under deposit bursts |
| **AI agents (Tier 2)** | Scales with **active agents**, not installs | HL IP weight, CoinGlass $, LLM $, keep **1** worker replica |
| **Neobank / UR banking (Tier 3)** | Do **not** assume the same as HL traders | Partner rails, webhooks/jobs, relayer gas, compliance ops |

When users exceed comfort: add FastAPI replicas, fund more relayer keys/ETH, upgrade Supabase/Privy/RPC, and for AI — dedicated egress, lower concurrency, or shard workers later.

---

## What you can skip

| Feature | Required for HL builder app? |
|---------|------------------------------|
| Bridge2 relayer | Strongly recommended for mobile UX; users can deposit manually without it |
| Rewards / referrals | No |
| Finnhub / Gemini caches | No |
| AI agents (`workers/ai-agent`) | No — optional Tier 2 |
| UR.APP neobank / IBAN / card | No — optional Tier 3 |
| Full multi-asset UI | No — niche apps encouraged |

---

## Further reading

- [Expected costs](./COSTS.md)
- [Setup guide](./SETUP.md)
- [Database / Supabase](./DATABASE.md)
- [Environment variables](./ENVIRONMENT.md)
- [Mobile release notes](./MOBILE_RELEASE.md)
- [Roadmap tiers](./ROADMAP.md)
- HL: [Rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits) · [Reserve additional actions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#reserve-additional-actions) · [Priority fees](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/priority-fees) · [HyperCore Tools (APIs)](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hypercore-tools#apis) · [Node repo](https://github.com/hyperliquid-dex/node)
- tradeXYZ: [Specification Index](https://docs.trade.xyz/consolidated-resources/specification-index) · [Announcements](https://t.me/tradexyz_announcements)
- HL API updates: [Telegram](https://t.me/hyperliquid_api) · [Discord `#api-traders`](https://discord.gg/hyperliquid)
- Privy: [React Native changelog](https://docs.privy.io/changelogs/react-native) (`@privy-io/expo`)
