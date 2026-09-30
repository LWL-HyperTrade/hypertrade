# BuilderPad Residents — AI agents with a face and a domain

A **resident** is an existing `workers/ai-agent` agent that lives on a BuilderPad app
(`{slug}.builderpad.xyz`). The app is the character's home: a VRM avatar on the
landing page, its book and decisions underneath, the perps desk behind **Launch App**.
Every order the resident places — and every order a visitor places on that desk —
carries the app's builder code, so the app earns builder fees from all trading activity.

Trading and AI logic are **not** re-implemented here. The resident is a normal row in
`ai_agents`; the hourly worker, prompts, guards, and the `/api/ai-agents*` control
plane are untouched except for the two additive hooks in §4.

Read first: [BUILDERPAD.md](./BUILDERPAD.md) (tenants, builder wallets, Activate),
[AI_AGENTS.md](./AI_AGENTS.md) (agent modes, worker).

---

## 1. Locked decisions

| Decision | Why |
|----------|-----|
| **Resident = tenant + agents.** No new product surface. | Landing, desk, wildcard subdomain, Activate, directory, coin, pledge are inherited |
| **Resident trades from its own embedded EOA (Privy HD 2), `mode = 'resident'`.** Not a sub-account, not the trade wallet. | Sub-accounts need ≥ $100k volume and it is unproven that a sub can `approveBuilderFee`. A fresh EOA is a plain HL user: it signs `approveAgent` + `approveBuilderFee` itself, has a clean public book, and HD 0 stays private. Same trick BuilderPad already uses for HD 1 |
| Wallet roles per login: **HD 0 trade · HD 1 builder · HD 2 resident.** All three must differ. | Builder must stay Standard; trader is unified; resident is public |
| **Full builder fee on resident orders**: `b = tenants.builder_address`, `f = tenants.builder_fee_tenths`. Preview apps → HyperTrade `b` like any preview desk. | The product is builder-fee revenue on all activity on that app |
| Resident wallet approves the app's builder at `0.1%` max once. | Fee edits (0–10 bps, append-only) never need re-approval |
| `mode='resident'` has its **own product-slot pool** (`MAX_AGENT_SLOTS_RESIDENT`), counted per Privy user like the others. | Slots are per user + mode; a resident must not eat the phone app's 2 Shared slots |
| One resident agent per login, on one app, trading from HD 2. Other apps on that login cannot add one until it is revoked. Dedicated sub-accounts (mobile, volume gate) are a later option, not this path. | One Hyperliquid account means one margin pool and one liquidation. A second live resident would share that risk |
| **Voice never trades.** Commentary is generated *after* decisions are logged, from stored `summary` lines; it cannot change size, side, or stops. | The worker remains the only signer |
| **VRM is the avatar format.** One shared `.vrma` animation set drives every avatar. Users pick a house preset (default) or upload a `.vrm`. | Humanoid retarget means N avatars × 1 animation set; no per-character art pipeline |
| Phase 0 is **house residents only** behind `BUILDERPAD_RESIDENTS_ENABLED`; the schema and endpoints are already multi-tenant. | Capacity is `active agents × hourly LLM/HL`, not pageviews |

Not in this tree: TTS, auto-posting to X, per-visitor chat with the resident, real copy-trading.

---

## 2. Data model

`backend/migrations/builderpad_tenant_residents.sql`

```text
ai_agents.mode                CHECK now allows 'resident'
tenants.persona   jsonb       { display_name, tone[], catchphrases[], show_hour_utc, bio_voice }
tenants.avatar    jsonb       { kind: 'preset', preset_id, poster_url } — kind=vrm is rejected until the upload sanitizer exists
tenant_residents  (tenant_id, agent_id UNIQUE, created_at)   -- deny-all RLS
ai_agent_voice    (id, agent_id, tenant_id, run_id, channel, mood, text, refs jsonb, created_at)
```

Resident wallet row: `tenant_builder_wallets.resident_wallet` + `resident_wallet_index`
(HD 2). Register/read through the existing `/tenants/me/wallets` pair endpoint.

Mood vocabulary (worker → UI): `idle · focused · tense · smug · shrug · sleep`.
Voice channels: `trade · craft · macro · vibe · fun · letter · cast`.

---

## 3. Control plane

Existing `/api/ai-agents*` routes are used as-is from the web (same Privy app, JWT).
`POST /ai-agents` with `mode: 'resident'` and `hlMasterAddress = HD 2`:

- ownership check is the existing Privy `user_owns_eth_address`
- copilot and dedicated creates are rejected when `hlMasterAddress` is the stored resident wallet (that master is the resident book)
- no sub-account, no copilot symbol-conflict guard (nothing manual trades on HD 2)
- product slot pool = resident (`MAX_AGENT_SLOTS_RESIDENT`)
- activate: same `$100` equity floor on HD 2, same `extraAgents` approval check

Tenant side (`backend/server.py`, helpers in `backend/tenant_residents.py`):

| Method | Path | Role |
|--------|------|------|
| POST | `/api/tenants/{slug}/residents` | Owner. `{ agent_id }`. Agent must be this user's, not attached elsewhere. `mode='resident'` + HD 2, **or** a house `SHOWCASE_AGENT_IDS` row (same Privy owner; keeps its existing master) |
| DELETE | `/api/tenants/{slug}/residents/{agent_id}` | Owner. Detach (agent keeps running; orders fall back to HyperTrade `b`) |
| GET | `/api/tenants/{slug}/resident` | Public, cached ~28s. `{ persona, avatar, mood, agents[] (showcase slice), voice[] }` |
| PATCH | `/api/tenants/{slug}` | Owner. Accepts `persona`, `avatar` (live-editable, like logo/fee) |

`GET /api/tenants/{slug}` and the directory include `resident: { count, persona, avatar } | null`.

---

## 4. Worker hooks (additive)

`workers/ai-agent/src/lib/tenantBuilder.ts`

1. **Builder resolution.** Once per cycle load `tenant_residents ⨝ tenants(status='live')`.
   `builderFor(agentId)` → `{ b, f, tenantId, cloidPrefix }` or HyperTrade defaults.
   The adapter receives it in its constructor; the four `exchange.order` sites use it.
2. **Attribution.** After every accepted order the adapter inserts a
   `tenant_order_attributions` row `(tenant_id, wallet=HD2, cloid, oid, symbol, side,
   notional_usd, builder_address, builder_fee_tenths, est_builder_fee_usd)`. The backend
   settle path joins `(wallet, oid)` to `userFills.builderFee` exactly as for desk orders.

Cloids keep the `HTAI` prefix (positions, showcase, and `frontend` rely on it). Fee
attribution is `(wallet, oid)`, never the cloid, so the prefix does not matter.

Voice (Phase 1) runs after `executeAgentMonitoring` returns: a deterministic mixer picks
a channel (or silence) from the decision types + calendar + sticky board; a cheap model
writes ≤ 80 tokens in the tenant's persona; rows go to `ai_agent_voice`. Caps: trade =
every action · craft ≤ 1/h · macro ≤ 2/day · vibe ≤ 1/6h (thin hours) · fun ≤ 1/day in
`show_hour_utc` after ≥ 3 quiet cycles · letter Sun 00:00 UTC · cast ≤ 1/day.

---

## 5. Web flow (`web/`)

Flag: `VITE_BUILDERPAD_RESIDENTS=1` (console) + backend `BUILDERPAD_RESIDENTS_ENABLED=1`.

**My Apps → `ResidentCard`** on a published app (same slot as Twitch / Launch token later):

1. **Resident wallet** — `createWallet({ createAdditional: true })` until HD 2 exists;
   `POST /tenants/me/wallets` stores it. Never HD 0 / HD 1.
2. **Fund** — send Arbitrum USDC to the resident address (HD 2), then deposit
   it with Bridge2. HD 2 signs the permit; the relayer pays Arbitrum gas.
   Minimum deposit is $5. This is the default because a normal trade wallet is
   `unifiedAccount` and cannot `usdSend`. A **Standard builder wallet**
   (`live=own`, not unified) may also `usdSend` from its Hyperliquid Available
   to HD 2. A never-used HD 2 costs **1 USDC** on that send; send ≥ `$101` so
   `$100` lands. Unified HD 0 is never the source.
3. **Agent** — ported mobile form (market, model, horizon, direction, mandate, leverage,
   notional ≥ `$100`, margin) → `POST /ai-agents { mode: 'resident', hlMasterAddress: HD2 }`.
   Market list is the app catalog minus the same HIP-3 exclude / pre-IPO gate as
   `frontend/src/lib/aiAgentHip3Exclude.ts`.
4. **Approve** — HD 2 signs `approveAgent(htai-…)` and `approveBuilderFee`. The builder is the app's own wallet only when that wallet holds ≥100 USDC perp and is not unified. Otherwise the resident credits the BuilderPad builder (`DEFAULT_BUILDER_ADDRESS`). The worker uses the same choice on orders.
   via `withUserSignedExchange(providerFor(HD2))`. Optional `userSetAbstraction` unified.
5. **Attach + activate** — `POST /tenants/{slug}/residents` then `POST /ai-agents/{id}/activate`
   (activate-first / 409 → sign → poll, same as mobile).
6. **Character** — look (Yuna / Selene), display name, and a short about line.
   Style, sayings, and a comments layer stay off this wizard. Hourly decisions
   stay the trading layer, same as the mobile agent.

Ported from `frontend/` as pure TS (no RN): `AI_AGENT_LIMITS`, request/response types,
client validation, model picker list, cloid (Web Crypto SHA-256). HL helpers reuse
`web/src/lib/hlTrade/` (`withUserSignedExchange`, `listHlExtraAgents`,
`getApprovedBuilderFeeTenths`).

**Landing (`CreatorPage`)** — `ResidentSection` above the App chapter when `tenant.resident`
exists: VRM stage (poster until the model loads), mood, last voice line, next-cycle
countdown, then the book. **Desk (`TenantApp`)** — `ResidentDock` next to Twitch
after the same `|` as Buy / markets. Collapsed chip (poster + green live pip +
overlay icon + dock lock); drag undocks like the stream. Expanded card is a
compact VRM + P&L (no voice). Both overlays can be open at once.

### VRM stage

`web/src/ui/resident/VrmStage.tsx` — `three` + `@pixiv/three-vrm` + `@pixiv/three-vrm-animation`.

- Loads the preset `.vrm` from `/resident/presets/{id}/`. Custom `https://` models are rejected. Body clips are `.vrma` only.
  **Green book (`smug`):** that preset's dance (`yuna` → `dance.vrma`, `selene` →
  `dance-2.vrma`) loops with the happy face. **Waiting:** shuffle that look's pool
  at random (no immediate repeat), including Resting with no live agent. Females
  and neutrals use `idle` / `modelpose` / `spin` / `vsign` / `gunshoot`. Males
  (Julian, Sebastian) use `spin` instead of `idle`, and skip `modelpose`. Bind / T-pose rest is not shown.
- Lazy: mounts only in view, `poster_url` otherwise. One canvas per stage.
- Camera (Hub photobooth): wheel zoom, left-drag orbit, right-drag pan.
  Default portrait framing is unchanged until the user moves it; double-click
  resets. Head look-at still follows hover when no button is down.
- Face: Hub/VRoid blend shapes already in the `.vrm`. The stage binds whatever
  names that file has (VRM 0 Fun/Joy/Sorrow/`Surprised` and VRM 1 happy/angry/sad/…).
  Mood comes from the live book: no position → idle, green uPnL → smug, red → tense,
  flat open book → focused, all agents stopped → sleep. Missing presets are skipped.
- Presets live in `web/public/resident/presets/{id}/`. Shipped looks: Yuna, Selene,
  Julian, Kuri (`kiba.vrm`), Mika, Sebastian. Posters are `poster.webp` or `poster.png`.
  The old `luna` id still resolves to Yuna.
- User uploads (Phase 4): glTF magic, ≤ 15 MB, VRM humanoid required; sanitizer on the backend.

---

## 6. Phases

| Phase | Ships | Status |
|-------|-------|--------|
| 0 | Migration, `mode='resident'`, tenant attach/detach, public `/resident`, worker builder + attribution, HD 2 provisioning, My Apps **ResidentCard** (wallet → fund → agent → approve/activate → character) | done |
| 1 | Voice mixer + generation in the worker (`ai_agent_voice` table + landing transcript already read it) | later |
| 2 | VRM stage + **The Resident** section on the landing, ResidentDock on the desk, worker-written mood | landing + dock done; mood stays derived until voice |
| 3 | Directory “Residents” row, Clone-this-mandate deep link, weekly letter, cast cross-talk | later |
| 4 | Open to users: preset gallery, `.vrm` upload + sanitizer, persona moderation, custom domain, coin | later |

---

## 7. Verify on testnet before flipping the flag

House lineup: log in to BuilderPad as the **Privy user that owns the `SHOWCASE_AGENT_IDS` rows** (the same login that created those agents). Open My Apps on a live tenant that login owns → Character (Yuna) → Agent → **Live here** on a showcase row. No HD 2 wallet. The HL master of those agents stays whatever they already trade from.

New user-owned residents still need HD 2 (`approveBuilderFee` signed by HD 2 after the address exists on Hyperliquid).

- Bridge2 into HD 2 (Arbitrum USDC on that address, relayer pays gas). A
  Standard builder wallet may `usdSend` instead. Do not `usdSend` from a
  unified trade wallet.
- Privy web: a second `createWallet({ createAdditional: true })` returns HD 2 and
  `signTypedData({ address })` works on it.
- A resident fill shows on the app card as volume + earned to the app's builder.
