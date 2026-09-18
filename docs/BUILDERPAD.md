# BuilderPad

**BuilderPad** is the Vite app in `web/`, deployed on **Vercel** as **[builderpad.xyz](https://builderpad.xyz)**. Creators log in, publish a **branded Hyperliquid trading app** (perps/spot desk, builder fee, Privy wallets, Bridge2), and optionally launch a token. It shares HyperTrade infra (same Privy app, Railway, Supabase, Bridge2). That is backend sharing, not the same product as the Expo retail app.

**HyperTrade Expo** = mobile retail trading. No BuilderPad UI in the store binary.

**Pons is a chapter, not the product.** The on-chain launchpad (`contracts/pons-v2/`, Robinhood Chain 4663) is the optional **Coin** step of the same wizard. Architecture matches live Pons; economics + `BuilderPadFeeEscrow` differ. Spec: **[PONS_FORK.md](./PONS_FORK.md)**. Public product docs: **`https://builderpad.xyz/docs`** (`web/src/ui/DocsPage.tsx`).

HIP-4 / predictions stay out of this tree ([orbcast](https://github.com/LWL-OrbCast/orbcast)).

Public app URL is `https://{slug}.builderpad.xyz`. The console is `https://builderpad.xyz`. Local/dev is `web/` on `:5173` (`/t/{slug}`). Do not ship BuilderPad inside the Expo app.

---

## Locked decisions

Do not reopen these without a product reason. They exist because of HL constraints, not taste.

| Decision | Why |
|----------|-----|
| **Own-builder is the live path.** Shared HyperTrade `b` is a collapsed **preview** | One order has one `b`. We cannot take a second builder fee on their fills. Platform take on live apps is the **$5 Activate fee** (Arbitrum USDC, once per builder) plus SaaS / invoice later |
| **Two EOAs on the same login.** Trade is always Privy HD 0 | HL builder codes require the builder address to stay **Standard** and hold **≥100 USDC perp**. The desk forces traders to `unifiedAccount`. The same EOA cannot be both. Email/Google mint HD 1 as builder. MetaMask login may use that EOA as builder **only** (`source=imported`); it is never the session trade wallet |
| HD 0 = trade. Builder = HD 1 **or** imported MetaMask | Trade: desk, trade Bridge2, `approveAgent`, `userSetAbstraction`. Builder: hold 100, stay Standard, receive `b`. **Never** run auto-setup or unify on the builder |
| Create the second wallet with `createWallet({ createAdditional: true })` only | Passing `walletIndex` fails for users who already have HD 0 (`use createAdditional instead of walletIndex`) |
| Provision HD 1 on console `/` and `/create` only | Desk-only traders on the **web** desk do not get a builder wallet |
| 100 USDC is **theirs**, per **builder address** | HL anti-sybil. Withdrawable if they quit. HyperTrade never custodies it. `MAX_TENANTS_PER_USER = 10`. Preview (shared HyperTrade `b`) is **`MAX_PREVIEW_LIVE_PER_USER = 1`** until Activate |
| **$5 Activate fee**, once per builder | Separate from the 100. Gasless USDC permit to `BUILDERPAD_ACTIVATION_TREASURY` (default `BUILDER_ADDRESS`). Skip Activate = still free preview |
| Order `b` is `tenants.builder_address` from the **server** | Never a client paste. Web desk only. HyperTrade Expo always pins HyperTrade and does not run BuilderPad |
| Attribute as **`(wallet, cloid)` or `(wallet, oid)`**. Never cloid alone | Prefix `0x4250` (`BP`) + sha256(tenant id)[0:8] + random. Must not collide with AI `0x48544149` (`HTAI`). Official cash is HL `userFills.builderFee` on **`(wallet, oid)`** |
| Same Privy App ID as HyperTrade (shared infra). Do **not** set the Expo Client ID on web | Separate **product**. Web may use a Privy **Web** client in `VITE_PRIVY_CLIENT_ID` |
| **BuilderPad is web only** | Vite `web/` at builderpad.xyz. Not in the HyperTrade Expo binary — no console, no tenant skin, no HD 1 on the phone |
| **One wizard, one go** | Create is three chapters in one session: **App → Activate → Coin**. Identity is filled once. The creator should feel they are about to earn from **perps builder fees and the token** together |
| **Activate is skippable, not hidden** | 100 USDC + Standard + Activate stays in the flow. Skip = app still publishes on HyperTrade `b` (preview). Copy must show they are leaving that 1B-preview take on the table |
| **Coin is the paid climax** | Launchpads already pay a launch fee (and often buy their own token). Pons `launchToken` is signed by **HD 0** with the protocol launch fee. Quiet “do coin later” if Pons is down — do **not** fail the app. HD 1 never pays Pons |
| **Revenue preview, always on** | While they set the app fee, the preview pane shows builder take at **$1B** notional: `tenths / 100000 × 1e9` (e.g. 50 tenths = 5 bps = **$500,000**). If skipped activate, label it as HyperTrade’s until they activate. Token side: quote-asset fees to them on the curve/pool (defaults, not extra sliders) |

---

## What shipped (current truth)

Status as of this doc. Live test tenant: slug `test-app` (catalog + fee already on that row).

### Product

| Piece | Behavior |
|-------|----------|
| Host | `builderpad.xyz` console + `{slug}.builderpad.xyz` apps. Not HyperTrade Expo |
| Auth | Same Privy **app** as HyperTrade (shared infra). Builder UX is web only |
| Wallets | `tenant_builder_wallets`: HD 0 `trade_wallet` vs builder (`source=embedded` HD 1, or `source=imported` linked MetaMask). Must differ; builder unique |
| Builder | Preview = platform `BUILDER_ADDRESS`. Live = HD 1 after ready + **Activate**. Copy says **Collecting fees** only after `live=own` and a settled fill |
| Public volume / earned | Directory / creator / home / My apps totals show `max(desk, HL lifetime)`. Volume and earned come from `referral.builderRewards` (fee total; volume = fee / rate). Attached only when `tenants.builder_address` is that creator’s claimed wallet — preview apps on shared HyperTrade `b` stay at 0 unless they imported that address. **Several live apps on one builder address** (an activated creator’s 2nd+ app): HL only knows the address, so the lifetime figure is **apportioned by each app’s desk-attributed `filled_notional_usd`** (`_builder_shares_by_tenant`); a new app with no fills shows 0, not its siblings’ history; all-zero → oldest app carries it. `hl_builder.share` / `shared_builder_apps` expose the split. Order count is desk-only (HL does not publish a builder order count on `referral`; fill CSVs are not publicly fetchable from this stack) |
| Fee | Creator sets 0–10 bps (0–100 tenths). The wizard rolls the **$1B-volume take** right next to the bps chips (volume toggle $100M / $1B / $10B) |
| Catalog | Wizard shows **Perps / Spot** selected and **Predictions soon**. Create still writes the full HyperTrade universe. Name / bio / socials / markets stay frozen after publish; **logo** may change. **Builder fee** can change; each change is append-only and shown on cards |
| Socials | **Connect-only.** X, TikTok, Instagram, YouTube (Google), Twitch (`custom:twitch`), Discord, Telegram via Privy. Server re-verifies against `/v1/users/{id}`; no `PRIVY_APP_SECRET` → handles dropped. Website is free text, labelled *not verified* |
| Twitch overlay | After publish. Connecting Twitch on the account links `socials.twitch` and turns the desk overlay **on** (My Projects toggle can still opt out). Handle stays Privy-verified — they cannot paste someone else’s channel. No Twitch connected → **Connect Twitch first**. Editable after publish (not identity). Desk: collapsed LIVE/Offline chip, draggable; expand loads the Twitch iframe (`parent` = current hostname, so custom domains work). Helix live check needs `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` |
| Wizard | App → Activate (optional) → Token. **Next: Activate** writes a `status=draft` tenant (one per user): slug reserved, not on the directory. Tab close after the $105 still resumes from My Apps. Last button flips `live` then launches the token. `sessionStorage` is a same-tab cache only. Word is **app**, never “desk”. **Preview cap:** one live app on shared HyperTrade `b`; Activate lifts it to 10. Create wizard also sets **buyback %** of the builder-fee take and **burn %** of that buyback (each 0–100 independently; e.g. 70% buyback then 50% of that burned). Same trust model as the fee: editable after publish, append-only history |
| **Token (Pons v2)** | **Wired.** Robinhood Chain `4663` (viem `robinhood`), HD 0 signs. Quote chips = ETH + Robinhood stock tokens the factory approves **live** (`GET /api/tenants/pons/quotes`; today NVDA, TSLA, AAPL, MSFT, AMZN, GOOGL, META, SPY, HOOD, COIN, MSTR, AMD, NFLX, PLTR, GME, AMC, SPCX, USDG). Dev buy in quote units → `launchAndBuy` (one tx, front-run proof); else `launchToken`. Dev buy shows **Available** quote balance + **Max** and a live `≈ tokens · % of supply` estimate (same math as `minTokensOut`). `expectedEconomics` pinned right before send, fresh `salt`, `launchFee()` as value. Advanced = `creatorTaxBps` (chips trimmed to live `maxCreatorTaxBps()`), buyback (default **off**), fee recipient (defaults HD 0 — router rejects zero), **team wallets** (snipe-tax exemptions, max 32; launcher + fee recipient auto-exempt). Gates: `canLaunch(HD0)` **and** funding — `useLaunchFunding` mutes the launch button (“Add ETH to launch”) until HD 0 holds launch fee + gas reserve (+ native dev buy; ERC-20 quotes also need the dev-buy balance); “Publish app without token” stays available. Publish still creates the app when the gate is closed or the tx fails. After confirm → `POST /api/tenants/{slug}/coin` → backend re-reads `getLaunchedToken` (`exists`, `deployer == owner_wallet`) → `coin_*` columns. My apps: claim (`claim` / `claimToken`) + unswept curve fees (phase 0) or hook `pendingFees` / `pendingCreatorTax` (phase 2); **Launch token** later for apps without one. Token **Buyback Yes/No** is on-chain (`setBuybackEnabled` from the fee recipient; Robinhood ETH gas). Directory / creator cards are one identity (shared logo, name, `$SYMBOL`, CA on its own row, socials beside the name). Two rows: app (volume, earned, builder fee) then token (mcap, holders, tax). Curve tokens get a graduation bar (`realQuoteReserve` / threshold). Age is `coin.launched_at`. Creator page token card shows **Dexscreener Paid / Pending / Not paid** from the free key-less `api.dexscreener.com/orders/v1/robinhood/{token}` (approved `tokenProfile` = paid; same signal launchpads badge as “DEX paid”), linked to the token page; on-curve stats (`pons-activity`) are keyed on token+curve only and use `keepPreviousData` so the block never blanks on refetch. Creator page `/t/{slug}`: right sidebar is **Visit app** (perps terminal) stacked over an in-app **curve buy/sell** ticket (docs quote math + `buy` / `sell`; 1% slippage; HD 0). Graduated launches point at Dexscreener — Uniswap v4 ticket is later. We do **not** scrape ponsfamily.com |
| **Creator identity** | Login-level, derived at read time (no table). `tenants.creator = { key, handle, kind, apps[] }` on directory + single reads: `key` = `sha256(privy_user_id)[:10]` (opaque, public), `handle` = first verified social by X → Telegram → Twitch → YouTube → TikTok → Instagram → Discord across *any* of the login’s live apps, `apps` = all live apps (oldest first). **No verified social → `creator: null`** and nothing is shown: unverified creators stay anonymous by design. UI hints only when 2+ live apps: card byline `by @handle · N apps` → `/explore?creator=key` (filter chip, dismissible); creator page **More from @handle** strip of the other apps; **Top creators** collapses a creator’s apps into one row (summed volume/orders, best app as face, links to the filtered Explore). Wallets and UUIDs are never used as identity |
| UI | Stamp buttons (2px ink border, hard offset shadow, hover = pressed) as on hypertrade.exchange / orbcast.xyz. `*` = required, `optional` pill otherwise |

### Activation state machine

`tenant_builder_wallets.status`:

1. **`provisioned`** — pair stored. Apps still use HyperTrade `b`.
2. **`funded`** — HL says the builder has ≥100 USDC perp **and** Standard (`userAbstraction` not `unifiedAccount` / `portfolioMargin`). Sync / GET wallets persist this. **Do not auto-downgrade** if equity later dips.
3. **`active`** — `live=own`. All non-archived apps for that creator get `tenants.builder_address` = that builder. New apps inherit it.

**Preview-first is the intended user path.** Publish and trade with $0 on HyperTrade’s `b`. Depositing 100 USDC only *funds* HD 1 (`status=funded`). It does **not** move apps. **Activate** is the explicit switch (`live=own`). They can sit funded in preview as long as they want. Home polls HL after deposit so Activate appears once credit lands. The card says **Collecting fees** only when live and a fill has settled — not before they have earned anything.

Home / Create: send Arb USDC to HD 1 (105 if they still need the 100 + fee, or 5 if already funded). **Activate** (Privy `signTypedData` on the **builder** address, `switchChain(42161)` first) signs the $5 fee permit then the Bridge2 permit **before either is submitted**. Relayer pulls the fee, then Bridge2. Sync / GET auto-sets `live=own` once the fee is recorded and HL shows ≥100 + Standard. Rejecting a signature charges nothing.

### APIs

Register **`/tenants/me/*` before** `/tenants/{slug}`.

| Method | Path | Role |
|--------|------|------|
| GET / POST | `/api/tenants/me/wallets` | Load / persist the pair. GET also reads HL and may promote `provisioned` → `funded` |
| POST | `/api/tenants/me/wallets/sync` | Re-read HL equity + Standard |
| POST | `/api/tenants/me/wallets/live` | `{ "live": "own" }` or `{ "live": "preview" }`. `own` requires the $5 fee recorded + HL ready |
| POST | `/api/tenants/me/wallets/activate` | Auth. `{ fee?, deposit? }` USDC permits. Fee spender = assigned relayer, destination pinned to treasury. Deposit spender = Bridge2. Sign both first; retry omits whichever already landed |
| POST | `/api/tenants/me/logo` | Auth upload. PNG/JPG/WebP, 2 MB. Magic-byte sniff + Pillow → public `tenant-logos` WebP (OrbCast avatar sanitizer) |
| GET | `/api/tenants/pons/quotes` | ETH + curated Robinhood stock tokens (`api.robinhood.com/rhj/assets`, `PONS_QUOTE_SYMBOLS` in `pons.py`) that pass `approvedPairTokens` + `pairTokenEconomics`. Process-global until that list / factory changes (`?refresh=true` to rebuild) |
| POST | `/api/tenants/{slug}/coin` | Owner. `{ token, tx_hash, chain_id, launch_config_id, symbol, dev_buy_quote, owner_wallet? }`. Re-reads factory `getLaunchedToken`; 400 if `deployer != owner_wallet`, 503 if RPC down. 409 if a coin exists. If the row has no `owner_wallet` (saved before Privy's wallet resolved) it is backfilled from `owner_wallet` in the body or the registered `trade_wallet`, after a Privy ownership check |
| POST | `/api/tenants/{slug}/coin/refresh` | Owner. Re-reads factory into `coin_buyback_enabled` / fee recipient after an on-chain `setBuybackEnabled` |
| POST | `/api/tenants` | Create. `status=draft` upserts the one unpublished wizard (slug reserved). Default `live`. Own `b` when pair `status == active` |
| DELETE | `/api/tenants/{slug}` | Owner. Draft only — discards the unpublished wizard and frees the handle. Live apps archive instead. Socials stay on the Privy login |
| PATCH | `/api/tenants/{slug}` | Owner. Draft may change slug / `wizard_draft`. `status=live` publishes (clears wizard_draft, sets own `b` if activated). Live may change logo, fee, pledges, and `stream.twitch` (not name/bio/socials/catalog). `owner_wallet` may be set / repaired (ownership-checked, never the builder wallet) until a coin is attached — the wizard sends it on every save |
| GET | `/api/tenants/{slug}/stream` | Public. Live/offline for the desk overlay. Channel comes from the tenant row, never the query string |
| GET | `/api/tenants` | Owner list + desk attribution + optional `hl_builder` |
| GET | `/api/tenants/directory` | Public launchpad feed (live apps + desk attribution + `hl_builder`) |
| GET | `/api/tenants/by-host` | Public. `?host=` → live app with a verified custom domain |
| POST | `/api/tenants/{slug}/domain` | Owner + **Activate**. `{ host }`. Subdomain only (`trade.` / `app.` / `www.` — not the bare domain). Returns TXT + CNAME to copy |
| POST | `/api/tenants/{slug}/domain/verify` | Owner. Checks TXT `_builderpad.{host}` and CNAME → Vercel, then attaches the host to the Vite project |
| DELETE | `/api/tenants/{slug}/domain` | Owner. Disconnects the hostname |
| GET | `/api/tenants/{slug}` | Public tenant (includes `builder_address` + `hl_builder` when claimed) |
| POST | `/api/tenants/{slug}/orders` | Attribution. Snapshots `builder_address` from the **tenant row**. Best-effort settle after insert |
| GET / POST | `/api/tenants/{slug}/orders` · `/orders/settle` | Owner fill refresh. Join `userFills` / `userFillsByTime` on **`(wallet, oid)`** |

Helpers: `backend/tenants.py` — `builder_ready`, `perp_equity_from_clearinghouse`, `is_standard_builder_mode`, `aggregate_user_fills_by_oid`, `settlement_patch`, `normalize_builder_address`. Threshold: `BUILDER_ACTIVATION_USDC = 100`.

---

## Deviations from the first sketch

The first write-up was “shared HyperTrade builder, paste nothing, ship a skin.” HL and product constraints moved us. Keep this list so we do not “fix” back to the sketch.

| First sketch | What we actually do |
|--------------|---------------------|
| One wallet; shared `b` forever | Two embedded EOAs. Shared `b` is **preview only** |
| “Fund the builder” on the same EOA you trade with | Impossible: unified trader ≠ Standard builder. Second address: HD 1 or imported MetaMask (never the session trader) |
| Create extra wallet with `walletIndex: 1` | **`createAdditional: true` only** |
| Silent setup = same three HL steps as mobile (incl. `approveBuilderFee`) | Silent setup on HD 0 is **agent + unified only**. `approveBuilderFee` runs on **first order** for that app’s `b` (else auto-setup would approve HyperTrade on an own-builder desk) |
| Order `b` pinned like mobile | Dead idea. BuilderPad web uses `tenant.builder_address`. HyperTrade Expo never runs tenant orders |
| Attribute by cloid prefix / `builder_fills` | Prefix is a tag only. Official fee is `userFills.builderFee` on `(wallet, oid)` |
| MetaMask / injected as the **session trader** | Rejected. MetaMask may be the **builder** (`source=imported`) if it is Standard. Session `address` stays HD 0. Create still rejects `owner_wallet == builder_wallet` |
| Auto-downgrade if they drop under 100 | No. Status stays `funded` / `active`. They can fail a later `live=own` re-check |
| Pick markets in the wizard (≤80) | Every HyperTrade market on day one. Editing the list is a later screen |
| Type your socials | Connect them. A handle only reaches the DB if Privy verified it for that login |

---

## Wallet isolation (builder must stay Standard)

The builder is not a second trading context. Putting it in order `b` does **not** sign as that wallet.

**In this app, the builder may:** exist, be displayed, sign **Activate permits** (5 USDC fee + Bridge2 deposit), and receive builder fees.

**In this app, the builder must not:** be session `address`, place/close orders, `approveAgent`, `userSetAbstraction`, trade-wallet Bridge2, or silent auto-setup.

Gates:

- Session `address` / `getEthereumProvider()` = `pickTradeWallet` (HD 0). Never an injected wallet. If trade and builder resolve equal, provider is `null`.
- `getBuilderEthereumProvider(address)` is used in **one** place (`web/src/ui/BuilderActivateCard.tsx`). It checks `eth_accounts` matches the stored builder, then aborts on mismatch. Imported builders sign that permit in MetaMask.
- Auto-setup / OrderTicket / TenantApp / WalletSheet deposit abort if session address equals builder.
- Mobile session picker (`frontend/src/lib/walletAccounts.ts`) prefers HD 0 and will not fall back to HD 1.
- Backend never signs `userSetAbstraction`. Sync / live only **read** HL. Imported register also rejects unified MetaMask.

Not gated (outside this app): they can take that EOA to app.hyperliquid.xyz or export the key and unify it themselves. We cannot stop that from our UI.

---

## Apply SQL

```text
backend/migrations/builderpad_tenants_v1.sql
backend/migrations/builderpad_tenant_order_est_fee.sql
backend/migrations/builderpad_tenant_order_reduce_only.sql
backend/migrations/builderpad_tenant_order_settlement.sql
backend/migrations/builderpad_builder_wallets.sql
backend/migrations/builderpad_imported_builder.sql
backend/migrations/builderpad_tenant_coin.sql
backend/migrations/builderpad_tenant_wizard_draft.sql
backend/migrations/builderpad_activation_fee.sql
backend/migrations/builderpad_tenant_fee_history.sql
backend/migrations/builderpad_tenant_custom_domain.sql
backend/migrations/builderpad_tenant_pledge.sql
backend/migrations/builderpad_pledge_burn_of_buyback.sql
backend/migrations/builderpad_tenant_stream.sql
```

Deny-all RLS (service role only). See [DATABASE.md](./DATABASE.md).

---

## Code map

| Path | Role |
|------|------|
| `backend/tenants.py` | Validation, reserved slugs, cloid, settlement, wallet helpers, `coin_view`, stream overlay |
| `backend/twitch_helix.py` | App-token Helix `GET /streams` for the desk LIVE chip. Optional; unset env → `live: null` |
| `backend/tenant_domains.py` | Custom domain host + TXT/CNAME + Vercel attach. Preview apps refused |
| `backend/pons.py` | Pons v2 reads: Robinhood registry → curated quotes → factory approval; `verify_launch` |
| `web/src/lib/pons/` | `chain.ts` (viem `robinhood`, doc addresses), `abi.ts` (verbatim doc ABIs, including hook `pendingFees`), `reads.ts` (curve + hook unswept fees, `poolIdForLaunch`), `launch.ts` (`launchToken` / `launchAndBuy`, initial-buy quote math, claim), `market.ts` (Dexscreener + curve quotes for cards), `trade.ts` (live `quoteBuy` / `quoteSell`, curve `buy` / `sell`) |
| `web/src/ui/CoinTermsFields.tsx` · `CoinLaunch.tsx` · `CoinFeesCard.tsx` · `LaunchCoinLater.tsx` · `CreatorAppCard.tsx` · `TokenTradeCard.tsx` · `CreatorPage.tsx` | Token chapter fields, runner (never re-sends a confirmed launch), claim card, launch-later, Home / My Apps identity card, creator-page curve ticket |
| `backend/server.py` | `/api/tenants*` (after `/builder-config`; `me/wallets*` before `{slug}`) |
| `web/src/lib/embeddedWallets.ts` · `auth.tsx` · `useEnsureBuilderWallets.ts` | HD 0 vs HD 1 vs imported MetaMask + console provision |
| `web/src/ui/BuilderActivateCard.tsx` | One **Activate** CTA: builder `switchChain(42161)` + Privy `signTypedData({ address })` for $5 fee then Bridge2. Auto `live=own` after credit. “Collecting fees” only after live fills |
| `web/src/ui/CustomDomainCard.tsx` | My Projects: TXT + CNAME copy + How it works. Activate-only |
| `web/src/ui/StreamDeskCard.tsx` · `web/src/ui/terminal/StreamDock.tsx` | Twitch overlay toggle (My Projects) + draggable LIVE chip on the desk |
| `web/src/ui/BuilderFee.tsx` · `AppPledge.tsx` · `EarningsHero.tsx` | Live fee + buyback/burn pledges, public change logs, create-wizard chips |
| `web/src/ui/TokenBuyback.tsx` | On-chain Pons `setBuybackEnabled` — Yes/No card + pencil. HD 0, Robinhood ETH gas |
| `web/src/lib/hlTrade` | Desk setup + `placeOrder`. `orderBuilderAddress(tenant.builder_address)` |
| `frontend/src/tenants/` · `frontend/app/t/` | **Leftover** from an early sketch (tenant skin inside HyperTrade). Not the product. Strip from the Expo app when convenient — BuilderPad does not ship there |

Est fee is place-time notional × tenths / 100000 — not cash received. Home **Refresh fills** calls settle.

---

## Web console (Vite + Privy)

Expo web still uses mock auth. Create / manage / activate on desktop:

```text
web/          Vite + @privy-io/react-auth (same PRIVY_APP_ID as mobile)
```

```bash
cp web/.env.example web/.env   # VITE_PRIVY_APP_ID + VITE_BACKEND_URL (+ optional Web client ID)
cd web && npm install && npm run dev   # http://localhost:5173
```

Vite proxies `/api` to `VITE_PROXY_TARGET` or `127.0.0.1:8000`. That process must be **this** HyperTrade backend, not OrbCast.

Privy dashboard: add `http://localhost:5173` (and the deploy host) to **allowed origins**, plus `/login` as the OAuth redirect. Same App ID as HyperTrade. If you create a Privy **Web** client, put that ID in `VITE_PRIVY_CLIENT_ID` — never the Expo/mobile client.

Desk agent name is **`HyperTrade Web`** so it does not replace the mobile agent `HyperTrade` (HL nonces-and-api-wallets). Click the signed-in email for the **trade** wallet + trade Bridge2. Fund the builder from Activate / My apps only. Existing builders: login with that MetaMask — we mint HD 0 for the desk and skip HD 1.

### Creator site (`{slug}.builderpad.xyz`, custom CNAMEs, local `/t/{slug}`)

`web/src/ui/CreatorShell.tsx` + `CreatorPage.tsx`. One landing page, creator-branded: their logo/name top-left, **Home · App · Token** scroll anchors, **Launch App** + login top-right. No BuilderPad sidebar, search, or byline. Footer = `© year {app_name} · Trading involves risk…` + Home / Terms / Privacy. `/terms` and `/privacy` on a creator host render with the creator's app name (`LegalPages.tsx`, operator stays LWL LLC). Sections keep the same five data points per row (App: Earned, Volume, Builder Fee, Buybacks, Burn · Token: Earned, Market cap, Trade fee, Buybacks, Creator Tax). Token sparkline is real: curve `CurveBuy/CurveSell` logs, or GeckoTerminal hourly closes once a pool exists. Hero uses `banner-top.webp`, then a slow muted partner-logo ticker, the App card `app-banner.webp`.

**Font:** the stack is `"Basel Grotesk", Inter, …` (same family as app.uniswap.org). Basel is a licensed typeface — drop `BaselGrotesk-Book.woff2`, `BaselGrotesk-Medium.woff2`, `BaselGrotesk-Bold.woff2` into `web/public/fonts/`. Until those exist the page renders in Inter.

---

## HyperTrade Expo

**Out of scope.** BuilderPad is not a screen in the HyperTrade app. Retail Expo keeps pinning HyperTrade’s builder.

The repo still has leftover `frontend/app/t/` + `TenantProvider` wrapping `_layout` from the first sketch. That is not the product. Strip it when we clean the Expo tree.

---

## Now / next / later

### Proven (web)

Own-builder activation works on the Vite desk: HD 1 funded + **Activate** → new orders snapshot `tenants.builder_address` = HD 1, HL fill `builderFee` matches, Supabase attribution row matches. Preview-first still stands (deposit ≠ activate). HD 1 must stay Standard.

### Proven (Pons v2, read-only)

Against the **official** live factory on `4663` (`simulateContract`, no tx sent): `launchToken` and `launchAndBuy` encode and simulate OK with our `TokenParams`; `launchAndBuy(0.1 ETH)` returned the **same `tokensOut`** our `quoteInitialBuy` derives from the docs' curve arithmetic (55649241146711635750421585), so `minTokensOut` is not a guess. Live values on that day: launch config `0` = 1B supply, 100 bps curve fee, 1.68 ETH phantom, 4.2 ETH threshold; `launchFee` = 0.0005 ETH; `maxCreatorTaxBps` = **1000** (docs say 5%, factory says 10% — we read it live); `canLaunch` was **true** for an unwhitelisted address, i.e. public launches were open.

### Our factory fork (`contracts/pons-v2/`)

Foundry project, compiler matched to the Blockscout-verified live stack (solc 0.8.35, cancun, optimizer 200, via-IR). 45/45 tests green. **Current stack (v2, `BuilderPad*` names) deployed on 4663 on 2026-09-14** — factory `0x519580283eAEabF01d5Db061862d180c4596e709`, all 61 txs succeeded, all 9 contracts Sourcify `exact_match`; full address table in [PONS_FORK.md](./PONS_FORK.md) §4 (v1 `0x1ef3bAD2…` is superseded). **Web + backend pin v2** (`web/src/lib/pons/chain.ts` `PONS`, `backend/pons.py` `PONS_*`); wizard buyback default is **off**. Economics (launch fee, curve fee, tax cap, snipe) are read live from the factory, not hardcoded.

Env for the fork is **not** `web/.env`. Three different Robinhood RPC vars — see [ENVIRONMENT.md](./ENVIRONMENT.md) (backend vs Vite vs Foundry) and PONS_FORK.md §4.

### Pons rules we follow (from [docs.ponsfamily.com/v2](https://docs.ponsfamily.com/v2) **only**)

**Never** use [docs.ponsfamily.com](https://docs.ponsfamily.com/) without `/v2` — that is **v1** (Uniswap v3, no curve, factory `0xA5aAb3…`). The ABI we follow is v2. **Our factory is our own fork** `0x519580283eAEabF01d5Db061862d180c4596e709` (`BuilderPadLaunchFactory`, [PONS_FORK.md](./PONS_FORK.md) §4) — not official Pons `0x7eD598Bc…` and not our superseded v1 `0x1ef3bAD2…`; tokens launched there do not exist on ours. Every `web/src/lib/pons/*` and `backend/pons.py` file repeats this.

| Rule | Where |
|------|-------|
| Pin `expectedEconomics` immediately before the tx; retry once on `LaunchEconomicsMismatch` | `web/src/lib/pons/launch.ts` |
| Fresh 32-byte `salt` per launch (CREATE2) | same |
| `launchAndBuy` needs an explicit `creatorFeeRecipient` (zero rejected) → default HD 0 | `buildTokenParams` |
| Native: `value = launchFee + quoteIn`; ERC-20: approve router, `value = launchFee` | `launchCoin` |
| Curve buy: native `value = quoteIn`; ERC-20 quote: approve curve, `value = 0` | `buyOnCurve` |
| Curve sell: approve the launch token, then `sell(tokensIn, minQuoteOut, recipient)` | `sellOnCurve` |
| Quote against live `getReserves()` + `sellableTokens()` + `currentSnipeTaxBps(recipient)` | `quoteBuy` / `quoteSell` |
| `minTokensOut` bounds the price, not the quantity → 1% under quoted rate | `launchCoin` / curve ticket |
| Only assets passing `approvedPairTokens` **and** non-zero `pairTokenEconomics` are offered | `backend/pons.py` |
| Never hardcode curve / token; read `TokenLaunched` from the receipt and `getLaunchedToken` server-side | runner + `verify_launch` |
| Escrow reads zero until a sweep → also show curve `quoteFeeBalance` + `creatorTaxBalance` (phase 0) or hook `pendingFees` + `pendingCreatorTax` (phase 2) | `readCreatorFees` |
| Socials struct is X / Telegram / Discord / website / Farcaster only | `coinDraftFor` |

### Next

- v2 `BuilderPad*` stack deployed on 4663, Sourcify-verified, web/backend swapped (done). Redeploy web + backend, then run the [PONS_FORK.md](./PONS_FORK.md) §8 test plan
- Apply `builderpad_tenant_coin.sql`
- First real launch on a test app (ours, after the swap); confirm `CurveBuy.tokensOut` vs our quote, then the claim path once a fill lands
- Privy socials in the dashboard, cancel open orders
- Basel Grotesk `woff2` files in `web/public/fonts/` (licensed; until then Inter)
- Production smoke: `{slug}.builderpad.xyz` landing + desk, custom CNAME (Activate only), wallet sheets, Google login

#### Pons — still out of scope

CTO / takeovers, migrations, buyback-vault release UI, Uniswap v4 swap ticket, indexer, snipe-exemption team list (launcher + fee recipient are already exempt), custom launch-config editor, HyperEVM factory.

### Later (not v1)

- **Edit** (name / bio / socials / catalog list-delist) — paused. Pons uploads metadata to IPFS; a BuilderPad edit that is not also a Pons update would desync. **Exceptions:** logo, builder fee, app buyback % (of the fee), burn % (of that buyback), and the Twitch desk overlay from My Projects. Overlay on may fill an empty `socials.twitch` from the current Privy login; it never changes an existing handle. **Token buyback Yes/No** is on-chain: `setBuybackEnabled(token, enabled)` on the Pons factory, signed by the current fee recipient (HD 0), Robinhood ETH gas. After the tx, `POST /api/tenants/{slug}/coin/refresh` re-reads the factory.
- Uniswap v4 swap ticket after graduation (curve ticket is in the creator sidebar)
- Vesting release, CTO, migrations
- OrbCast / HIP-4 as a plugin, not in this repo
- A separate builder **mobile binary** only if that product exists later — not HyperTrade Expo

### Custom domains (activated builders)

Preview apps **cannot** attach a domain. Activate (`live=own`) first.

One Vite SPA on Vercel (Pro) + one FastAPI. Hostname → `GET /api/tenants/by-host`. Canonical public URL is `https://{slug}.builderpad.xyz`. Apex `/t/{slug}` redirects there. Localhost and `*.vercel.app` still use `/t/{slug}`. Do **not** deploy a Vercel project per creator.

**Platform subdomain** (every live app, no extra DNS from the creator):

1. In Vercel, add `builderpad.xyz`, `www.builderpad.xyz`, and `*.builderpad.xyz` to the Vite project.
2. DNS: apex + www as Vercel documents, plus a `*` CNAME to `cname.vercel-dns.com`.
3. Privy allowed origins: `https://builderpad.xyz`, `https://www.builderpad.xyz`, and `https://*.builderpad.xyz`. That covers every `{slug}` without a dashboard edit per app.

**Creator-owned subdomain** (`trade.theirbrand.com`, Activate only):

1. My Projects → enter the address.
2. Copy **TXT** (`_builderpad.{host}` = token) and **CNAME** (host → `cname.vercel-dns.com`, override with `BUILDERPAD_VERCEL_CNAME`).
3. They paste both in Advanced DNS at GoDaddy / Namecheap / etc. How it works is on that card.
4. Check DNS. Backend looks up TXT + CNAME, then `POST` the hostname onto the Vite Vercel project (`BUILDERPAD_VERCEL_*`). HTTPS is Let’s Encrypt on that project — they do not buy a cert.
5. Add `https://{host}` to **Privy allowed origins** (dashboard; no public API). Same App ID. Fans may need to sign in again on the new origin.

Apex (`yourdomain.com` with no name in front) is not v1.

Env: [ENVIRONMENT.md](./ENVIRONMENT.md) `BUILDERPAD_VERCEL_TOKEN` / `PROJECT_ID` / `TEAM_ID`. SQL: `builderpad_tenant_custom_domain.sql`.
