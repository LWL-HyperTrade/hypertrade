# AI Trading Agents — V1 Plan

Multi-tenant AI agents that trade Hyperliquid perps for users, ported from the
`crypto-prediction-market` brain (`frontend/src/trader-ai-agent/` reference copy).
Focus of V1: **integration flow first** — brain logic is a placeholder to be
reviewed/improved after the pipes work.

## Scope

**V1 in:** main-dex HL perps (majors) · two agent modes · symbol-conflict guard ·
Supabase reasoning logs · periodic monitor loop · pause/stop/revoke · dashboard ·
dry-run (shadow) mode as launch gate.

**V1 out (V2 notes):** Pinata/IPFS mirror, daily-open routine, gamma terciles
(needs Deribit book greeks), brain logic overhaul, agent marketplace.

**HIP-3 / stock tickers — next (no longer blocked by funding myth):** see
**HIP-3 for AI agents** below. Spike proved agent wallets can trade `xyz:*` on
`unifiedAccount` without JIT `sendAsset` / `agentSendAsset`. Remaining work is
symbol plumbing + CoinGlass venue wiring, not a pre-fund ceremony.

## Agent modes

**Both modes ship:** **Shared** (`mode=copilot` — main wallet, notional caps) and
**Dedicated** (`mode=dedicated` — HL sub-account, volume-gated). OSS fork summary:
[AI_AGENTS.md](./AI_AGENTS.md). The old “unified can’t do sub-accounts” story was
wrong. Probe + app path (`scripts/hl-unified-subaccount-probe.mjs`, 2026-08):

| Action | Result under master `unifiedAccount` |
|---|---|
| `createSubAccount` | Works (HL **≥ $100k** lifetime volume — [docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/sub-accounts)) |
| `subAccountTransfer` / `subAccountSpotTransfer` | Rejected: `Action disabled when unified account is active` |
| `userSetAbstraction(sub, unifiedAccount)` | Needed — new subs often report `"default"`; without this, spot funding isn’t worker-tradeable |
| `sendAsset` spot→spot master→sub / sub→master | OK — exact amounts in probe |

App wiring: `ensureSubAccountUnified` + `transferUsdToSubAccount` (`sendAsset`) in
`hyperliquid.ts`; wizard funds at create; agent card **tap Dedicated balance**
opens `DedicatedTransferBottomSheet` (no auto-reclaim on delete). Flags:
`DEDICATED_MODE_ENABLED` / `AI_AGENT_DEDICATED_ENABLED`.

| | Copilot (shared) | Dedicated |
|---|---|---|
| Eligibility | everyone (default) | HL ≥ $100k lifetime volume (or already has a sub) |
| Trades from | user's main balance, capped by `max_capital_usd` | segregated sub-account balance |
| Isolation | soft: budget cap + symbol-conflict guard + bot-tagged orders (`cloid` prefix `0x48544149` "HTAI") | hard: separate clearinghouse |
| Fund / pull back | n/a | Create-time Funding amount + Transfer sheet (`sendAsset` spot↔spot). Notional/leverage caps match Shared |

### Config limits (keep in sync with `backend/ai_agents.py` + `AI_AGENT_LIMITS`)

| Limit | Value | Notes |
|---|---|---|
| Max symbols / agent | **20** | Soft cost/latency cap (CoinGlass + LLM per symbol); not an HL hard limit |
| Min / max budget (`max_capital_usd`) | **$100** / **$10M** | Notional cap (shared + dedicated). Dedicated also asks a separate create-time funding USDC amount |
| Min HL equity to activate / stay live | **$100** | Activate gate + worker auto-**pause** if equity drops below (resume re-checks). Open HL TP/SL left intact |
| Dedicated sub-account volume gate | **$100k** qualifying HL volume | HL protocol gate. Use fee-tier / `referral.cumVlm` style contribution — **not** raw `portfolio.allTime.vlm`. HIP-3 growth-mode volume usually counts at **~10%** |
| Min per-position (`max_position_usd`, optional) | **$20** | Also cannot exceed the agent's notional ceiling |
| Max leverage cap | **50** | Further clamped per-asset to HL `maxLeverage` |
| Shared product slots / wallet | **2** | HL ~3 named agents total; device `HyperTrade` uses 1. Independent of Dedicated. Stop keeps slot; revoke frees it. Enforced in app + create / draft-activate |
| Dedicated product slots / wallet | **10** | HL base sub-account limit after volume unlock. Independent of Shared (up to 2+10). Same stop/revoke rules. Enforced in app + create / draft-activate (`p_max_product_slots` counts peers in the same `mode`) |
| Max active agents / user (backend) | **12** | Concurrent `status=active` ceiling (advisory-locked) so a full Shared+Dedicated fleet can run; distinct from per-mode product slots which also count stopped/paused |

Worker floors live orders at ~$15 notional (`MIN_ORDER_USD`) above HL's exchange minimum — separate from the create-form floors above. Agent notional budgets **≤ $500** also get a **small-budget pump** toward ~$250 (clamped by remaining budget / `max_position_usd` / margin) so probe fractions on dust equity don't open meaningless ~$15 clips.
- **Margin-dust sweep (2026-07-31, recalibrated 2026-08-10)** — after trims, high-leverage stubs can sit at a few dollars of margin while still clearing the $15 notional min (live: BTC ~$2 margin / HYPE ~$12 at max trims). Worker closes stubs when **margin &lt; floor**, where floor = **max($15, pct × max_capital)** then **capped at 50% of opening margin**. Percents: **scalper 1% / swing·investor 0.5%** of notional `max_capital` (was 5%/3% — over-fired because shared `max_capital` is notional, not wallet margin; live BTC Accm $20k → $1k floor vs ~$31 opening margin → first trim always full-closed). Only once the position is a reduced stub (`trim_count > 0` or size ≤40% of opening). Also escalates a trim to full close when the *remainder* would be margin-dust. Close reason `margin_dust`; skips the LLM.

### Symbol-conflict guard (enforced in adapter not prompt)
- AI defers to user: skip opening any coin where the master holds a position the
  agent doesn't own → decision logged as `skipped_user_conflict`.
- Same-wallet copilots run **sequentially** in a cycle and claim symbols
  (`skipped_peer_symbol`) so two agents don't open the same coin / race margin.
- Reconciliation each cycle: if user closed/reduced the AI's position manually,
  adopt reality (`closed_by_user`), never re-open.
- User is never blocked; portfolio shows a bot icon (nav to `/ai-agents`) on
  AI-managed coins; agent card Live Positions jumps to portfolio.

## Ownership & tamper resistance

Nobody can read, modify, or run someone else's agent:

1. **RLS deny-all** on all `ai_agent*` tables — no client (anon or authed
   Supabase key) can touch rows; only the backend/worker service role.
2. **Control plane scoping** — every FastAPI `/api/ai-agents*` route verifies
   the Privy JWT and filters strictly by the caller's `privy_user_id`.
   Agent creation additionally verifies `hl_master_address` is a wallet
   actually linked to that Privy user (embedded EOA or SIWE-linked external
   wallet from `linked_accounts`) — you cannot register an agent against an
   address you don't own.
3. **HL protocol binding** — `approveAgent` binds the agent key to the ONE
   master that signed the approval. Even a fully tampered DB row cannot make
   an agent key sign for a different account, and agent keys can never
   withdraw funds (HL guarantee).
4. **Key encryption** — agent keys and BYOK API keys are AES-256-GCM
   ciphertext under `AGENT_KMS_KEY` (Railway env only); DB-only compromise
   reveals nothing.

## Custody & signing

- Per-agent HL keypair generated in the worker, AES-256-GCM encrypted under
  `AGENT_KMS_KEY` (Railway env), ciphertext in Supabase.
- User approves it as a **named HL agent** (`approveAgent`, name `hypertrade-ai-<n>`)
  — coexists with the device's manual trading agent key; separately revocable.
- Embedded (email/social) users auto-sign the approval silently; external wallet
  users get a wallet prompt (reuse `ExternalWalletSetupModal` ceremony pattern).
- Agent keys can only sign L1 actions (orders) — HL protocol prevents withdrawals.
- LLM output is untrusted input: `validateOpeningResponse` + adapter hard caps
  (leverage ≤ cap, size ≤ budget, symbol allowlist, reduce-only integrity).

## Data pipeline

- **CoinGlass v4** — V1 still requires a working user CoinGlass key (probe each
  cycle). Phase 1 fetches the **full series once per symbol** (cache key =
  `SYMBOL`), not once per `symbol::apiKey`. Junk keys never freeload.
  - Hobbyist BYOK ($29): 30 req/min, **intervals ≥ 4h** → V1 runs on **4h bars**.
  - Optional `COINGLASS_HOUSE_KEY`: house pays the heavy pull; agents still must
    probe OK. Planned product path: Standard commercial house key ($299,
    300 req/min, 1m intervals) + drop user key from the wizard (global symbol
    cache; users don't paste CoinGlass keys).
- Endpoints (all `{code:"0", data:[{time,...}]}`, values string-or-number → normalize):
  - `/api/futures/price/history` — OHLC + `volume_usd` (Binance → Hyperliquid → OKX/Bybit; **no Coinbase on perps**). Soft-skip symbol if all miss.
  - Prefer Hobbyist-ok **aggregated** coin series when available:
    - Futures agg list: `Binance,OKX,Bybit,Hyperliquid` (taker / OI / funding OI-weight / liq)
    - Spot agg list: `Binance,Coinbase,OKX,Bybit,Hyperliquid` (taker)
    - Pair-level fallbacks if agg empty
  - Spot price `/api/spot/price/history` — Coinbase-first (`COIN-USD`), then Binance/HL/OKX/Bybit; **best-effort**
  - Premium/basis: computed (futures close vs spot close) when spot exists; flags already null-safe
  - HL long/short ratio endpoint is plan-gated (401 on Hobbyist) — skipped
- **Deribit public DVOL — free, no key, house-cached** — **BTC/ETH only**
  (`supportsDeribitDvol`; SOL/XRP return empty from Deribit today). Other
  symbols skip Deribit entirely; options series stay empty and IV flags degrade
  gracefully. Refresh ≤ every 25 min (brain's `optFresh` guard is 30 min).
- `computeScalperFlags` consumes the same `MarketData` shape via a CoinGlass
  adapter; gamma fields stay `'na'` (graceful degradation built in).

## Architecture

```
Railway project "zooming-balance"
├── hypertrade-main (FastAPI)  ← control plane: /api/ai-agents CRUD, Privy JWT
├── cron-job (existing)
└── ai-agent-worker (Node/TS at workers/ai-agent/)
     scheduler: leader-gated loop (worker_leader row 'ai_agent_worker')
       phase 1: CoinGlass once per symbol (+ key probe for entitlement)
       phase 2: p-limit fan-out; copilots on same master run sequentially
     HL: HlCycleCache (wallet bundle / open orders / mids per cycle)
         + HlWeightBucket (IP weight budget; default 600/min, raise on
           dedicated egress). Static outbound IP recommended on Railway.
     stores: Supabase (service role), no public HTTP
```

## Supabase schema (service-role only, RLS deny-all, keyed by privy_user_id)

- `ai_agents` — mode, status (`active|paused|stopped|revoked`), master/agent/subaccount
  addresses, `hl_agent_key_ciphertext`, `config jsonb` (symbols, models, budget,
  leverage_cap, schedule), BYOK ciphertexts (CoinGlass + model keys), `dry_run`.
- `ai_agent_positions` — mirrors old `TrackedPosition` + `agent_id`, `cloid_prefix`.
  `last_check_at` set on open and on each monitor check; `stop_loss` /
  `take_profit` should track live exchange triggers (reconcile if they drift).
  Status is coarse (`OPEN` | `CLOSED` | `CLOSED_BY_USER`); **`close_reason`**
  is the analytics label:
  - External (`CLOSED_BY_USER`): `stop_fill` | `take_profit_fill` |
    `liquidated` | `closed_externally` | `adopted_on_revoke`
  - Agent exit (`CLOSED`): `exit` | `cut` | `flip` | `trim_escalated` | `margin_dust`
  External classification matches close price to tracked SL/TP (±15 bps); a
  user-edited trigger that no longer matches DB levels becomes
  `closed_externally`.
- `ai_agent_decisions` — `decision jsonb`, `reasoning jsonb` (replaces Pinata IPFS).
  Newer rows also carry an optional `summary` (opening: top-level via spread;
  monitors: under `decisionBody`) — 1-2 plain-English sentences for
  non-traders, display-only, always stored/shown with a `Summary: ` prefix.
  For HIP-3 equities with Massive options data, `reasoning`/`reason` is
  instructed to lead with equity options (ATM IV / put-call) before perp
  OI/CVD. The metric-citing `reason`/`reasoning` stays the audit trail and is
  what feeds back into monitor prompts (`getRecentMonitorDecisions` reads
  `decisionBody.reason` only, so the machine loop never sees the summary).
- `ai_agent_runs` — per-cycle audit + `equity_snapshot` (feeds dashboard chart).

Migration: `backend/migrations/ai_agents_v1.sql`.

## HL execution adapter (`workers/ai-agent/src/hl/adapter.ts`)

Server-side port of the *narrow* slice of `frontend/src/lib/hyperliquid.ts`
(RN file not importable — SecureStore/Expo coupling). `@nktkas/hyperliquid`
ExchangeClient with the decrypted agent key; `vaultAddress` / `defaultVaultAddress`
for Dedicated mode. Builder fee attached to every order (same as manual trades).

Notable behavior (as-built):
- **Unified account free margin** — `spot USDC − margin used` (raw perp
  `withdrawable` is often ~0 in unified mode; do not use it alone).
- **TP/SL** — `positionTpsl` + `s='0'` (position-linked). Move SL =
  cancel existing SL oid(s) then place (same as portfolio UI). Accept HL
  status string `waitingForTrigger` as success.
- **Exit/cut** — reduce-only IOC with in-cycle retries on 429/transient errors;
  re-check flatness so a second LLM call is not required.
- **Monitor stop intents** — winning `stopManagement` / losing `newStop`
  (`breakeven` | `tighter`) → replace SL when never-loosen + market-side
  guards pass; persist `stop_loss` in DB.
- **Budget** — `max_capital_usd` + optional `max_position_usd`; ADD uses
  agent-wide tracked notional + free margin, not only the single position size.
- **Price-% vs ROE in monitor prompts** — thesis thresholds stay in raw
  price-% (calibrated; leverage doesn't change whether a thesis is right, and
  ROE-fed thresholds would panic-trim a 40x agent on 0.05% wiggles). Leverage
  enters as a separate `LEVERAGE RISK CONTEXT` block (ROE, margin at risk,
  liquidation distance from HL `liquidationPx`) with a rule that urgency
  (trim/tighten-stop) scales with liquidation proximity — see
  `brain/prompts/leverage-risk.ts`. The legacy `$250 max daily loss` line was
  replaced by loss-vs-margin. UI/decision logs keep showing ROE (`pnlPct`),
  plus `liquidationDistancePct` for debugging.
- **Live price in decisions (2026-07)** — monitor + opening decisions use HL
  live mid (`getMidPrice`, cycle-cached) with the 4h bar close only as
  fallback; decision logs carry `priceSource: 'hl_mid' | 'bar_close'`. Opens
  persist the ACTUAL fill (entry/notional read back from HL, like flips).
- **Monitor memory (2026-07)** — `previous_decisions` fed from
  `ai_agent_decisions` (last 3 since open, price-% basis) so the momentum
  rules ("dropped >1.5% since last check") actually fire. Opening thesis
  (`reasoning`, `invalidation_criteria`, `key_metrics`) persisted on
  `ai_agent_positions.thesis` (migration `ai_agents_v3_position_thesis.sql`)
  and rendered in both monitor prompts; the losing monitor self-evaluates the
  stored criteria when no precomputed status exists.
- **Opening efficiency (2026-07)** — FLAT/below-conviction answers are
  memoized per (symbol, model) against the 4h bar timestamp
  (`skipped_no_new_bar`): no re-ask until a new bar closes (~75% fewer
  opening calls). "ALWAYS TRADE" contradiction removed — FLAT is
  first-class. Session-range stop anchors (`planStops`, both sides,
  leverage-neutral, **per `assetClass` geometry** — crypto keeps BTC/ETH
  mins; equity/index ~2% floor / 6% cap; commodity slightly tighter;
  forex ~0.4% floor so FX isn't forced to a crypto 2% stop) rendered in
  the opening prompt; TP floor enforced at 1.5R (validator stretches
  anything < 1.2R).
- **Live-notional budget headroom (2026-07)** — caps stay entry-basis by
  design (winners are never force-trimmed for outgrowing
  `max_capital_usd` / `max_position_usd`), but headroom for NEW opens/adds
  uses `max(entry size_usd, live mark notional)` per position, so a pumped
  position consumes budget at mark value instead of leaving phantom room.
- **Conviction (2026-07)** — sizing bands re-keyed from composite-score
  "edge" to the model's conviction (30-44→0.2, 45-59→0.4, 60-74→0.6,
  ≥75→0.8) with an explicit "conviction is YOUR holistic judgment, the
  composite score is one input with blind spots" instruction; the validator
  hard-clamps size to the conviction band. `compositeScore` {long, short} is
  logged on every opening decision for later conviction-vs-outcome
  calibration.
- **Macro calendar (2026-07)** — `data/macroCalendar.ts`: US public holidays
  (Nager.Date, free) + seeded high-impact macro events (2026 CPI dates from
  the BLS schedule, FOMC decision days from the Fed calendar — extend the
  seeds yearly, never guess dates). Full calendar in `global_context_cache`
  (`macro_calendar_v1`, 7d TTL) + 5-min in-process memo. Prompts get ONLY a
  relative slice via `renderCalendarSection`: today's date line + up to 4
  events in the next 7 days ("US CPI — Tuesday 2026-07-14 (in 3 days)"),
  plus an event-risk rule when a HIGH event is within ~24h. Attached as
  `sessionContext.upcomingEvents` in the cycle; rendered in opening + both
  monitors. (Before this, only the opening prompt knew the date — via its
  ISO timestamp — and monitors only knew session/weekend flags.)
- **Spot-ETF flows (2026-07)** — `data/etfFlows.ts`: CoinGlass
  `/api/etf/{bitcoin|ethereum|solana|xrp}/flow-history` (Hobbyist-covered),
  BTC/ETH/SOL/XRP only (other symbols skip, same pattern as Deribit DVOL).
  Globally cached (`global_context_cache`, key `etf_flows_<SYM>`, 6h TTL —
  flows report once per US trading day). Features: latest/prev day flow,
  5d/30d nets, inflow/outflow streak. Rendered as "INSTITUTIONAL DEMAND"
  section in opening + both monitor prompts, framed as daily bias context,
  never an intraday trigger.

- **Engagement fixes (2026-07-13)** — after a fully-FLAT weekend+Monday:
  (1) `callModel` retries once on transient failures (timeout aborts like
  "This operation was aborted", 429/5xx, network resets) so one hiccup
  doesn't forfeit the hourly decision slot. (2) Freshness guards in
  `computeScalperFlags` are now interval-aware (latest bar within one
  inferred bar interval + 30min slack) — the fixed 20-min guard zeroed
  strong-flow flags and told models "data is stale → min size" on healthy 4h
  data every cycle (this closes deferred fix 4's worst half early).
  (3) Exploratory-probe tier: conviction within 10 pts under the gate
  (weekday 15-24, weekend 20-29) may open at hard-capped 0.1 size instead of
  FLAT; validator floor lowered 0.2→0.1, band clamp caps sub-gate conviction
  at 0.1, worker gate moved to the probe floor, `probe: true` logged on
  executed/dry-run decisions.

- **Risk profiles + de-steering (2026-07-13)** — all four models were
  producing near-identical FLAT reasoning: the prompt was a checklist with
  many sanctioned exits and one narrow path to trade. Two-layer fix:
  (a) De-steering for ALL profiles — "OPENING RULES" reframed as
  "REFERENCE SETUPS (textbook patterns — NOT necessary conditions)" with an
  explicit independent-analyst instruction (may trade a cited off-template
  thesis, expected to sometimes disagree with the composite score).
  (b) `config.risk_profile: 'standard' | 'aggressive'`
  (`brain/riskProfile.ts` holds the gates so prompt and worker can't drift).
  Active-entry (aggressive) gates: normal 20 / thin-hours 22; patient
  (standard) gates: normal 25 / thin-hours 30; probe floor = gate−10.
  Guards modulate SIZE instead of mandating FLAT on the active path
  (session, chop, calendar event-risk). Size bands, stops, budget caps and
  monitor risk management are IDENTICAL across profiles — more positions,
  never bigger. Opening cache key + flat-bar memo include the effective
  profile. Backend validates the field; `riskProfile` logged on opening
  decisions (internal). Prompts never say "aggressive"/"standard" — they
  use **ENTRY APPETITE** vs **THIN HOURS** (see below).

### CoinGlass Standard pivot (2026-07-16) — global mode + 1h bars

- **Global-cache mode** — `COINGLASS_GLOBAL_MODE=1` (set on BOTH backend and
  worker; worker also needs `COINGLASS_HOUSE_KEY` = the Standard key). Users
  no longer supply personal CoinGlass keys: phase-1 fetches every active
  agent's symbols with the house key (no per-user probes), the monitor's
  entitlement check is bypassed, backend create/activate stop requiring the
  key (still stored if provided), and the app hides the key step (server
  flag `coinglassGlobalMode` on `GET /ai-agents`). Unset the env to revert
  to BYOK — all legacy paths preserved.
- **Interval 4h → 1h** (`INTERVAL '1h'`, `BARS 120` ≈ 5 days) — every hourly
  cycle sees a freshly closed bar: no more `skipped_no_new_bar` idling
  between 4h closes and no boundary lag for slow symbols. Capacity at 300
  req/min (Standard), pace 240/min: ~8 GETs/symbol → whole 38-symbol universe
  ≈ 1.5 min/cycle, ~8× headroom.
- **Freshness recalibrated** (was deferred fix 1) — guards are interval-aware
  (latest bar open within one interval + 30 min slack; fallback 1h). Opening
  prompt now says "1h bars over ~5 days; 3-bar = 3 hours".
- **Bar catch-up (no missed decisions)** — phase-1 re-polls symbols whose
  just-closed bar hasn't been emitted yet (90s poll, up to
  `BAR_CATCHUP_MAX_MINUTES`, default 4; 0 disables) before agents run — a
  slightly late cycle beats an idle hour; on timeout agents decide on the
  previous bar. The flat-opening memo is now keyed by the WALL-CLOCK bar
  window (not the data's bar timestamp), so a laggy feed can never produce
  `skipped_no_new_bar` on an hourly cadence — that log type only remains for
  future sub-interval re-runs.
- **CoinGlass same-cycle retry (2026-08)** — if a symbol's first pull throws
  or soft-misses (no usable OHLC), phase-1 waits **10s** and retries **once**
  before giving up / memoizing HIP-3 absence. Complements (does not replace)
  the slower bar catch-up loop. Still no LLM-style multi-retry storm; after
  that, `skipped_no_data` and try again next hour.

- **CVD path features (2026-07-16)** — computed LOCALLY from the taker
  buy/sell series already fetched (the CoinGlass CVD endpoints just cumsum
  the same data — zero extra requests). New flags: `cvdNet24Usd` /
  `spotCvdNet24Usd` (24-bar net taker delta), `cvdPersistence12`
  (one-sidedness), `cvdDivergence` (price vs CVD extremes, 12v12 halves,
  >0.1% new-extreme filter). Divergence dampens the chasing side in the
  composite score (×0.85 / ×1.1) + drivers. Prompts get one compact "Flow
  Path (CVD)" block: net deltas + spot-confirms-vs-perp-led + divergence
  with a one-line action hint ("do NOT chase").

- **Context blocks v2 (2026-07-16, Standard endpoints)** —
  • Macro calendar upgraded: `/api/calendar/economic-data` (US,
  importance_level 3 only) with **forecast vs previous** values rendered
  inline; seeded CPI/FOMC list kept as fallback (BYOK / fetch failure);
  cache key bumped to `macro_calendar_v2`, TTL 12h.
  • `data/hlPositioning.ts`: HL wallet cohort positioning
  (position-distribution size tiers + pnl-distribution PnL tiers),
  position-VALUE weighted long% for whales/retail/smart-money/exit-liquidity
  + smart-vs-crowd skew line. Chosen over L/S account ratios (spam-account
  noise). Global cache 30m, house-key only. Rendered in opening + both
  monitors (3 lines).
  • `data/marketMood.ts`: Fear & Greed (with 7d-ago) + stablecoin mcap 30d
  trend — 2 lines, OPENING prompt only. Global cache 6h.
  • `data/hlWhales.ts`: HL $1M+ whale positions
  (`/api/hyperliquid/whale-position`, Startup+) — per-symbol whale bias +
  REAL liquidation clusters (short-liq value within +3%/+10% above price =
  squeeze fuel; long-liq value within −3%/−10% below = cascade fuel). One
  global fetch for all symbols, 20m TTL; rendered per symbol in opening +
  both monitors, only when whales hold that coin. NOTE: CoinGlass's
  synthetic liquidation-map/heatmap endpoints turned out to be
  **Professional-tier only** (docs plan tables) — real whale positions are
  the better signal anyway and are covered by Standard.

- **Trading horizon (2026-07-16 / investor 2026-07-21 / cadence 2026-07-31)** —
  `config.horizon: 'scalper' | 'swing' | 'investor'` (default scalper;
  `brain/horizon.ts` holds the profile table). All share 1h bars + hourly
  worker wakeups. Scalper: hourly opens + hourly monitors. Swing: **hourly
  opens** + hourly monitors, flag lookbacks ×4, loose stops, TP floor 2R,
  monitor thresholds ×2.5. Investor: **hourly opens** (catch options/macro),
  **4h monitors** by default (skip mid-window LLM unless liq distance <3%,
  earnings ≤48h, near stop <1.5%, or last thesis WEAKENED/INVALIDATED —
  logs `skipped_monitor_window` / `[monitor-window] early look`), flag
  lookbacks ×6, TP floor 3R, monitor thresholds ×4, ≤3x leverage guidance,
  EMA/macro-heavy temperament for weeks/month+ holds. Wizard: three-pill
  selector; swing warns >10x, investor warns >3x. Backend validates the enum.
- **Sticky narratives board (2026-08-01)** — global macro/theme backdrop for
  all horizons (geo, rates, crypto regulation, commodity supply, etc.).
  Gemini + Google Search synthesizes a compact JSON board into
  `global_context_cache` (`sticky_narratives_v1`) **twice daily** at
  **02:30 UTC** (Asia cash morning) and **15:30 UTC** (~1h after US equity
  open) — claim window is the following 60 minutes so the hourly :00 cycle
  still picks it up without colliding with a "noon UTC" stamp. Agents only
  *read* the cache on open/monitor (no per-decision search). Prompt card
  marks each theme `unchanged` / `intensified` / `new` / `resolved` plus
  Gemini scores: `sentiment` 0–5 (0–1 bearish · 2–3 neutral · 4–5 bullish),
  `tradability` 0–5 (reprice power now), `horizon` days/weeks/structural, and
  a board-level `boardSentiment`. `unchanged` / low trad (≤2) must not move
  conviction; `intensified`/`new` with trad ≥4 may nudge size/timing only
  (never a hard conviction formula). Empty cache bootstraps once on first
  leader cycle after deploy. Requires `GEMINI_API_KEY` on the worker.
- **Per-symbol ticker catalysts (2026-08-01)** — name-specific sticky stories
  (Clarity Act for CRCL, partnerships, unlocks, lawsuits, product, …) in
  `global_context_cache` keys `sticky_symbol_<TICKER>_v1` (12h TTL). At the
  Asia/US slots, active symbols whose board is from a previous slot re-sync
  (up to **8**/cycle, parallel); outside slots a **3**/cycle bootstrap so new
  names aren't blind after deploy. Failed refresh keeps the prior board on a
  **2h** retry TTL instead of a full 12h. Themes:
  `REGULATION` / `PARTNERSHIP` / `PRODUCT` / `UNLOCK` / `LEGAL` /
  `MACRO_LINK` / `M_AND_A` / `FUNDING` / `TOKENOMICS` / `GOVERNANCE` /
  `SECURITY` / `TEAM` / `NETWORK` / `ETF` / `OTHER`. Same sentiment /
  tradability / horizon scores + optional ticker `boardSentiment` as the
  global board. Earnings *dates* and BTC/ETH/SOL/XRP spot-ETF *flow streaks*
  stay on structured blocks (`earnings`, `etfFlows`) — catalyst fetch skips
  routine earnings cards and flow-streak recaps; `ETF` theme is for
  filings/approvals/new products only. Prompt section **TICKER CATALYSTS**
  on open + winning/losing monitors; same status/score weighting as global.
- **Probe churn-loop fix (2026-08-06)** — live scalpers showed 21/23 closes
  as `margin_dust` with ~1.5h lifetimes: probes open below conviction 40 →
  the winning monitor's absolute "< 40 → trim" decay clause fired at the
  FIRST check → the trim's remainder fell under the dust floor → escalated
  to a full close. Three worker changes (`monitor.ts`):
  (1) decay clause `tc < 40` now applies only to positions that OPENED ≥ 40
  (probes are judged on `open−25` decay + thesis status instead);
  (2) trim→dust escalation on positions younger than **3 monitor windows**
  downgrades to HOLD (`trimSkippedYoung` logged; stop/TP untouched; cut/exit
  paths unaffected);
  (3) the standalone margin-dust sweep also skips positions younger than 3
  monitor windows.
- **Crypto EXTENSION / EXHAUSTION (2026-08-09)** — `isCryptoAsset` only (skip
  equities/metals/HIP-3). Soft stretch features so crypto agents see when they
  are chasing a run-up instead of only momentum (flow/OI/premium). Sources:
  CoinGlass `/api/futures/rsi/list` (`data/rsiList.ts`, global cache ~30min —
  fields `rsi_1h` / `rsi_4h` / `rsi_24h` as 1d / `rsi_1w`); EMA % stretch from
  the existing `coinglass_ema_list_v1` resolved by coin (same list HIP-3 uses);
  local wall-clock 3d/5d run-up + funding/OI percentiles from already-fetched
  bars (`data/cryptoExtension.ts`). Compact **EXTENSION / EXHAUSTION** block on
  opening + winning/losing monitors. Soft rules: UNLOCK/TOKENOMICS + stretched
  → don't chase longs / size down (never auto-SHORT on RSI); winning trim only
  when extreme **and** (crowded funding or WEAKENED); losing oversold + no
  invalidation = noise / DCA zone. Logged as `cryptoExtension` on decisions +
  into opening `key_metrics` (like `compositeScore`). **No worker gate** yet.
- **Crypto scalpers on 30m bars (2026-08-06, "sharper eye")** — cadence stays
  HOURLY; only the fetched bar size changes for crypto+scalper agents
  (`barIntervalForAgent` in `data/marketCache.ts`): at each :00 decision the
  last closed bar is ≤30min old and flags get 2× resolution. Wall-clock
  lookbacks are preserved — `computeScalperFlags` gets histWindow ×2 and
  windowScale ×2, so "3-bar flow" still spans 3h and the 1h-tuned thresholds
  hold. Market cache is now keyed `symbol|interval` (`marketDataCacheKey`) —
  the same symbol can be fetched at 30m for a scalper and 1h for a slower
  horizon (different masters); bar catch-up + `isSymbolCurrent` are
  interval-aware via `CoinglassMarketData.barIntervalMs`. 30m fetch = 240
  bars (~5 days). `lastBarLiquidations` sums trailing bars to a full hour so
  monitor "last 1h" labels stay truthful; opening prompt bar labels follow
  `barIntervalLabel`. HIP-3 scalpers stay on 1h (thin tradeXYZ book —
  options/daily closes lead; off-session sub-hour bars are internal-pricing
  noise). Known minor effect: `planStops`' `medBarRange` fallback (early-UTC
  session) reads smaller 30m bar ranges — bounded by the 2% min-stop floor.
  Stage 2 (deliberately NOT built): 30m opening looks for scalpers (monitors
  stay hourly) — revisit only if 30m flags show scalpers seeing-but-missing
  intra-hour setups.
- **Single-symbol cap (2026-08-04)** — new agents are limited to ONE symbol
  (`MAX_SYMBOLS_PER_AGENT = 1` in `backend/ai_agents.py`,
  `AI_AGENT_LIMITS.maxSymbols = 1` in the app). Rationale: decisions are
  per-symbol with no portfolio coordination — multi-symbol budget contention
  was first-come (not conviction-ranked), correlated exposure invisible, and
  direction/mandate are per-agent so per-asset strategy is the honest unit.
  Existing multi-symbol agents are grandfathered (worker code paths intact;
  validation only runs on create/edit). App copy updated to singular
  ("Asset to trade", FAQ whichMarkets/notionalBudget). TODO(portfolio-brain):
  lift the cap once a portfolio-level pass exists — conviction budget across
  assets, correlation awareness, opportunity cost (see docs/ROADMAP.md).
- **Direction constraint + mandate (2026-08-03)** — two optional config
  fields, orthogonal to horizon/riskProfile (`brain/mandate.ts`):
  `direction` = `long_short` (default, "Free form") / `long_only` /
  `short_only`; `mandate` = `active` (default — one-sided swing campaign) /
  `accumulate` (requires a direction: long = buy weakness, never chase, trim
  rarely; short = sell euphoric strength, never chase breakdowns, cover
  rarely; funding drag is an explicit act-reason in monitors since
  accumulation runs on perps — positive funding pays a short campaign).
  Accumulate places **SL only — no on-exchange TP** (position row stores
  `take_profit: null`, so the monitor re-ensure pass and the app both see
  no TP); the model still returns `take_profit_target` (validator R-floor
  unchanged) as a reference level, and monitor prompts state the missing TP
  is by design. Entries are never forced — the conviction gate applies, so
  an accumulate agent can sit flat for days waiting for weakness/euphoria.
  Worker-enforced:
  disallowed opening direction → `skipped_direction_mandate` (treated FLAT);
  monitor flip into a disallowed side → downgraded to cut. Opening prompt
  cache key includes `direction:mandate` so constrained agents never consume
  free-form cached answers. No leverage force — the app floats a warning
  above 3x for accumulate (like investor). Backend validates enums and
  rejects `accumulate` without `long_only`. Wizard: "Trading style" pills +
  "Goal" pills (shown for Long only).
- **Worker-enforced opening guards (2026-07-21)** — soft prompt text proved
  ignorable (TSLA opened conv 24 with earnings next day), so these are now
  code gates in `considerOpening` (each logs its own decision type):
  • `skipped_earnings_window` — equity ≤48h to earnings needs conviction above
    the risk-profile gate (standard 50 / aggressive 35,
    `earningsConvictionGate` in `brain/riskProfile.ts`); prompt text states
    the same per-profile number.
  • `skipped_trend_filter` — swing/investor counter-trend vs the 1d/1w EMA
    stack needs conviction ≥50 (scalper exempt).
  • `skipped_cooldown` — after a loss-close (trim_escalated/stop/cut/liq or
    realized_pnl<0) no fresh opens on that symbol for the horizon cooldown
    (scalper 1h / swing 1h / investor 2h). Kills the hourly reopen churn.
  • **Last-close card on opens (2026-08-03)** — within that same reopen
    window, winning/`closed_externally` flattens (and any other recent close
    after cooldown) inject a compact **LAST CLOSE** block into the opening
    prompt (side, reason, price, realized PnL, age). Soft context only: do
    not chase the exit move; same-side reopen needs fresher confirmation.
    One DB read shared with the cooldown check; opening cache key includes
    `closedAt` so agents with different recent closes do not share answers.
  • **OpenAI terra temperature (2026-08-03)** — `gpt-5.6-terra` (and legacy
    `gpt-5.4` aliases that route onto it) reject non-default `temperature`;
    the worker omits the field so OpenAI uses its default (1). Sending 0.5
    produced hourly 400s after project allowlist was fixed.
  • Investor: conviction gate 35 (testing value — raise later), NO probe
    tier, engine open-leverage cap 3x (was prompt-only).
  • Non-crypto monitors floor thresholds at swing values (crypto-calibrated
    price-% read fee-level equity wiggles as invalidation).
  Prompt text mirrors every gate via the same helpers/profile fields.
- **CoinGlass memo persistence (2026-07-21)** — venue/spot-miss/HIP-3-miss
  memos round-trip through `global_context_cache` (`coinglass_memos_v1`,
  7d TTL) so redeploys stop replaying the probe-error burst.
- **HIP-3 brain context (2026-07-21)** — asset-class tagging
  (`brain/assetClass.ts`); tradeXYZ underlying session + discovery-bounds
  block (`data/xyzSession.ts`, America/New_York schedules); CoinGlass
  `/api/futures/ema/list` globally cached (`data/emaList.ts`, GOLD→XAUT /
  SILVER→XAG aliases) + SP500/DXY beta one-liners; equity earnings from
  `earnings_cache` with 48h open gate. Crypto Fear&Greed / HL cohort /
  BTC ETF flows / Deribit options-positioning gated off for non-crypto.
  Margin mode stays on live HL meta per asset (some xyz markets support
  cross — never assume isolated-only).
- **Equity HIP-3 hybrid context (2026-07-22)** — primary stack: Massive
  options → EMAs → earnings → SPY/QQQ/DXY beta → US macro calendar.
  Secondary thin venue slice: HL premium / funding / OI Δ% (+ brief flow);
  cross-exchange CVD + liq percentiles omitted on equities. Calendar
  (`macroCalendar.ts` / CoinGlass `economic-data`) prefers equity-moving
  prints (CPI/PCE/FOMC/NFP/PPI/GDP/Retail/JOLTS), caps ≤4, and adds a
  ≤2h PRINT WINDOW line when `publishAtMs` is known. Whales still render
  only when $1M+ positions exist on that symbol.
- **Equity options context (2026-07-22)** — `data/equityOptions.ts`: listed
  US options chain via Massive (ex-Polygon.io, `MASSIVE_API_KEY` on the
  worker; Pro plan = 15-min delayed, fine for hourly cycles). Near-ATM
  (±12% strikes) ≤21d window → ATM IV + Δ vs previous snapshot, put/call
  day-volume / premium / OI ratios, day-vol/OI turnover. Globally cached
  30min per ticker; equity HIP-3 only; tickers with no US options chain
  memoized 24h and render an explicit "no options data — don't cite options"
  disclaimer. Rendered in opening + both monitors; opening prompt weights it
  above venue micro for stocks and swaps rule 4 / tie-breakers / citeMetrics
  to equity-options variants. GOLD/SILVER use the same Massive path via
  GLD/SLV proxies (see metals hybrid). Other commodities/FX/indices deferred.
- **AI HIP-3 symbol allowlist (2026-07-22)** — create/edit picker +
  `validate_agent_config` reject coins in `AI_AGENT_HIP3_EXCLUDED_COINS`
  (`backend/ai_agents.py` / `frontend/src/lib/aiAgentHip3Exclude.ts`):
  PURRDAT/SMSN/BOT/CXMT, forex, other commodities (not GOLD/SILVER),
  XYZ100/SP500. DRAM + EWY kept (US ETFs with options). **GOLD + SILVER
  re-enabled** with metals hybrid stack (below). SKHX renamed → **SKHY**
  (Nasdaq ADS of SK Hynix) app-wide + Supabase.
- **Metals HIP-3 hybrid (2026-07-22)** — GOLD→**GLD**, SILVER→**SLV** Massive
  options proxies (`data/equityOptions.ts`; ETF spot for strike window —
  never HL metal $). Primary: METALS OPTIONS + DXY + metal EMAs (XAUT/XAG)
  + FOMC/CPI calendar. Secondary thin HL venue micro. No earnings gate.
- **Options depth + skew (2026-07-23)** — `equityOptions.ts` chain fetch now
  paginates (`next_url`, ≤4×250 — dense weekly chains like TSLA overflowed
  one page and silently dropped later expiries from P/C totals). New fields:
  **skewPts** (median OTM put IV − call IV, 3–10% wings — the risk-reversal
  read; institutions hedge in skew, not P/C volume) and **nearestAtmIvPct**
  (nearest-expiry-only ATM IV so expiry rolls don't masquerade as IV moves).
  P/C premium language softened — snapshot volume has no aggressor side.
- **Daily structure from Massive aggs (2026-07-23)** — `data/equityDaily.ts`:
  real US consolidated daily closes (~430d, adjusted, 6h global cache; SPY
  benchmark shared) for equity + GLD/SLV HIP-3 → EMA 20/50/200 stack,
  52-week position, 1m/3m momentum, RS vs SPY, 20d realized vol. Rendered
  as **DAILY STRUCTURE — PRIMARY trend basis** in the opening prompt; in
  monitors it REPLACES the CoinGlass perp-EMA block when present (token
  neutral). The swing/investor **trend filter** (opening gate) and the
  opening-prompt gate text both prefer the daily 20/50/200 stack over
  perp-venue EMAs (`stackSource` logged on skips).
- **Thesis-persistence guard (2026-07-23)** — losing-monitor "would I enter
  fresh now?" reframe caused evidence-free trims/cuts on patient horizons
  (live: trims whose own reason said "not fully invalidated"). Worker now
  enforces for swing/investor: **cut/flip need thesis INVALIDATED or ≥2/3
  cut triggers** (else downgraded to trim ≤0.33), **trim needs thesis ≠
  INTACT** (investor: also ≥1 trigger; else hold). Downgrades log
  `downgradedFrom`/`downgradeReason`; horizon monitor prompts state the rule
  so models cite fired criteria instead. Scalper unchanged; stop/TP and
  liquidation safety untouched. Corollary: investor `minConvictionGate`
  raised 35 → **40** (positions that are evidence-gated on exit must be
  harder to enter; 45 is the production target once the 40-50 band has
  closed-trade calibration). Swing entry gates unchanged — its guard is
  lighter and stops still bound each trade.
- **HIP-3 venue OI demoted (2026-07-24)** — crypto-exchange OI on thin
  xyz books is not equity/metals positioning (listed options are). Opening +
  both monitors omit venue OI from cite/tie-break/cut/ADD/EXIT for
  equities/metals; worker forces `cutTriggers.oiAgainst=false` and
  thesis-guard counts only premium+flow (2 triggers). Venue **liquidation
  clusters** kept for scalper/swing as local HL squeeze/cascade fuel (not
  global options liquidations); investor horizon treats them as noise unless
  the position's own liq distance is threatened.
  Opening + both monitors; platinum/oil/etc. still excluded.
- **Conviction tracking in monitors (2026-07-26)** — monitors now output
  `thesis_conviction` (0-100, current belief in the ORIGINAL entry thesis —
  distinct from `confidence`, which scores the chosen action); the winning
  monitor also gained `thesis_status` (mirror of the losing monitor's). Both
  prompts render a **Thesis Conviction Trajectory** line (opening conviction →
  values from the last 3 checks, read back from
  `decisionBody.thesis_conviction` via `getRecentMonitorDecisions`) and each
  previous-decision line shows its conviction. Guidance: conviction tracks
  thesis EVIDENCE, not mark-to-market — losing monitor anchors it to
  thesis_status (INVALIDATED ≤ 20); winning monitor uses material decay
  (≥ 25 pts below opening, or < 40) toward TRIM/EXIT so winners with a dying
  thesis get banked. Stored under `decisionBody` for UI/audit.
- **Winning thesis-decay guard (2026-07-27)** — worker upgrades idle winning
  `hold`/`add` when thesis has decayed (live BTC: WEAKENED + conviction ~17
  while green, checklists unmet → parked). Rules: **INVALIDATED → exit**;
  **WEAKENED or conviction ≤ open−25 / < 40 → trim 25%** (if trims remain;
  max-trims still short-circuits further trims to hold). Logs
  `upgradedFrom`/`upgradeReason`. All horizons — this is winner discipline,
  opposite of the patient losing-side thesis-persistence guard. Prompt states
  the worker will enforce so models prefer returning trim/exit themselves.
- **Risk profile — TEMP aggressive default (2026-07-16)** — testing-phase
  data collection: `FORCE_AGGRESSIVE_RISK_PROFILE = True` in
  `backend/ai_agents.py` forces every created/edited agent to 'aggressive';
  the app hides the selector (`RISK_PROFILE_SELECTOR_ENABLED = false` in
  `app/ai-agents.tsx`, state defaults aggressive). Flip both flags to
  restore user choice — standard-profile code fully intact.
- **Thin-hours auto-downgrade (2026-07-18)** — decide-time only (never
  mutates DB). Window: **Fri 19:00 UTC ≤ t < Sun 21:00 UTC**
  (`isThinLiquidityWindow` in `brain/session-context.ts`; same flag backs
  prompt `isWeekend` / session "Thin hours"). Inside the window,
  `effectiveRiskProfile()` forces patient/`standard` gates + thin-hours
  prompt block even when stored config is aggressive — skips the last US
  Friday hour, releases before Asia open Sunday so Mon-Asia can run full
  entry appetite. Outside the window, stored profile applies. Prompt copy
  uses "thin hours" / "entry appetite", not product profile names.

- **Ops polish (2026-07-17)** — spot-miss memo in `coinglass.ts`
  (futures-only coins like LIT skip the spot venue chain for 24h — saves ~5
  GETs + log noise per cycle); `DEBUG_STORE_PROMPTS` env (set `1` or an
  ISO/epoch expiry — auto-expires) persists full prompts under
  `reasoning.prompt` + `promptDebug: true` for spot-checks; agent health
  gained `recoveredAt` + a "back to normal" push on degraded→healthy (only
  when the incident was actually alerted, ≤7d) and daily RE-alerts while
  `exit_retrying` persists (funds at stake — other reasons stay
  transition-only).

- **Gamma excision + options positioning (2026-07-17)** — gamma removed
  everywhere (score's 0.15 weight redistributed to flow/OI/premium; prompt
  rules/tie-breakers/metrics rewritten IV-only; monitors' "Gamma Environment"
  line dropped; winning ADD condition #4 → spot-CVD confirmation). Dead
  rule-helpers (`makeOpeningSuggestion` etc.) deleted. `regimeTag` +
  `regimeBias` now render in the opening Regime Context. New
  `data/optionsPositioning.ts` (BTC/ETH, global cache 1h, 2 GETs/refresh):
  options ΔOI 24h + vol/OI turnover (`option/info`) and premium-weighted
  put/call ratio from `option/max-pain` per-expiry market values (max pain
  price itself deliberately NOT rendered — weak at our horizons). Strike-level
  signals (GEX/DEX/walls/skew/term structure) are not available from
  CoinGlass at any tier; future path = processing Deribit's public chain.
  Next brain step by design: calibration pass over logged
  compositeScore/conviction vs realized PnL before any composite reweighting.

- **Risk-parity sizing + account-leverage guard (2026-07-18)** — openings
  size by EQUAL DOLLAR RISK AT THE STOP, not notional:
  `risk$ = equity × tierRisk% × sizeBand/0.8`,
  `notional = risk$ / stop-distance%` (stop distance clamped 0.5–10% so a
  gamed tight stop can't inflate notional; session-range stops make this
  vol-parity for free). Leverage no longer influences size — in cross mode
  per-name leverage is capital efficiency, not risk (observed live: liq
  distance tracked notional, not leverage). Legacy budget-fraction sizing
  remains the fallback when equity/stop data is missing. New wallet-level
  guard on opens AND adds: total wallet notional ≤ `ACCOUNT_MAX_LEVERAGE`
  (default 4) × equity. Existing caps (budget, per-position, margin×lev)
  unchanged as outer clamps. Decisions log `sizingMode/riskUsd/stopDistPct/
  equityUsd/walletNotionalUsd` for calibration. **Small-budget pump (2026-07-21):**
  when agent notional budget ≤ **$500**, open size is floored toward **$250**
  (or the full budget if smaller) before those clamps — stops $15 dust probes
  on paper wallets. Correlation caps explicitly
  NOT implemented (product decision — keep minimal; symbol-conflict guard
  already prevents same-symbol stacking).

- **Liquidity-tiered risk% (2026-07-19)** — same risk-parity formula; the %
  is symbol-tiered via shared `liquidityTier` (also used by adaptive
  slippage): BTC/ETH + mid-liquid catalog → `RISK_PER_TRADE_PCT_LIQUID`
  (default **4%**); thin alts → `RISK_PER_TRADE_PCT` (default **2%**).
  Decisions also log `riskPerTradePct` + `liquidityTier`. No user toggle.

- **Pyramid base + losing DCA (2026-07-19)** — ADD/DCA size against
  `thesis.opening_size_usd` (not post-trim size) so a trim cannot shrink
  later pyramids. Winning monitor keeps ADD (3/4 + chop defense). Losing
  monitor gains a distinct **`dca`** action: thesis INTACT, 0/3 cut
  triggers, chopRisk or low vol, loss still under 50% of distance-to-stop
  (else horizon-scaled ~2% price loss), max 2 DCAs/position, size
  0.15–0.33× opening base; soft checklist ≥2/4 in the prompt. Worker
  hard-rejects DCA when gates fail.

- **Position identity (2026-07-20)** — reconcile no longer treats
  same-symbol+same-direction as automatic ownership. Uses existing
  `entry_price` / `opened_at` / `cloid_prefix`: fill walk detects
  flatten→foreign reopen (non-HTAI cloid); entry within 3% is the
  fallback. Portfolio bot badge matches live entry+side, not coin alone.
  Tracked `entry_price` syncs from HL when still ours (add/DCA drift).
  Tracked `size_usd` also syncs to live entry-notional (units×entry) on
  manual user trim/add so portfolio bot badge + later % sizing stay honest;
  `thesis.opening_size_usd` is left alone (pyramid base).

- **HIP-3 agents enabled (2026-07-20)** — the old "agents can't fund HIP-3"
  V1 blocker was wrong for unified accounts (spike proof:
  `spikes/prove-agent-send-asset/prove-xyz-order.ts` — agent key opened/closed
  `xyz:TSLA` with $0 on the xyz clearinghouse; spot USDC is the margin
  source; agentSendAsset NOT used and deliberately avoided). Enablement:
  • Adapter: `SUPPORTED_HIP3_DEXES = {'xyz'}`; dex-aware meta/asset ids
    (100000 + dexIndex×10000 + idx via `perpDexs`), mids/funding via
    dex `metaAndAssetCtxs` (45s cache), positions merge main + traded-dex
    clearinghouses, unified free margin subtracts per-dex `totalMarginUsed`,
    `onlyIsolated` assets skip cross, TP/SL via `frontendOpenOrders({dex})`.
  • Backend: `xyz:COIN` symbols validated + canonicalized (dex lower, coin
    upper); mirrored `SUPPORTED_HIP3_DEXES`.
  • CoinGlass: HIP-3 coins run the FULL normal pipeline on the coin part
    (TSLA appears in /futures/supported-coins; Binance/OKX list
    tokenized-stock perps, so aggregates + venue fallbacks + spot discovery
    all apply — do not pre-restrict to the Hyperliquid venue, that guess
    failed live for TSLAUSDC). NO fallback data source (product decision
    2026-07-20): HL-native candles alone are too weak for stock decisions —
    when CoinGlass has nothing the agent SKIPS (`skipped_no_data`) rather
    than trade on thin context. A 24h "CoinGlass missing" memo stops absent
    pairs from burning failed GETs / catch-up budget every cycle. (An
    `hlCandles.ts` fallback existed for ~1 commit — deleted; retrievable
    from git if ever wanted.) Stock-signal handling (macro/TA, longer
    horizon) is the planned follow-up discussion.
  • Isolated-margin risk (2026-07-20): isolated liq distance ≈ 1/leverage —
    the shared pool does NOT back the position, and for the SAME notional
    (same PnL) lower leverage just posts a bigger buffer at zero cost when
    margin is free. Isolated opens therefore treat leverage as the
    LIQUIDATION-BUFFER DIAL: use the lowest leverage that achieves
    max(`ISOLATED_LIQ_BUFFER_PCT` (default 10%), 2× stop distance), rising
    above that only when free margin forces it, never past the
    stop-before-liq ceiling (lev ≤ 1/(1.5×stop)) or the user's cap. The
    user's leverage setting is a MAX, not a target, for isolated.
    `AdapterPosition.marginType` (HL leverage.type) feeds the monitors'
    LEVERAGE RISK block ("ISOLATED — margin is the entire buffer; treat liq
    as hard"). Mixed cross/isolated baskets are allowed by design —
    mode-aware handling makes blocking them unnecessary.
  • Frontend: agent symbol picker merges `/assets` (xyz:* only) into the
    crypto list; leverage-cap resolution covers HIP-3 maxes.
  Known gaps (accepted for test phase): equities market-hours awareness
  (weekend gaps/closed sessions) and stock-specific context blocks.

### Deferred brain fixes — ALL CLOSED (2026-07-16)

1. ~~Fabricated zeros in monitor prompts~~ — done: `liquidations_1h` is the
   real last-1h-bar liq $ (null → prompts render "N/A — do not cite"),
   `iv_change` is an honest DVOL-pts-since-entry (null when entry predates
   the ~24h IV window), `basis_change_bps` is real premium drift since the
   entry bar (funding deltas were already wired earlier via
   `marketFundingBpsNearOpen`). NEVER-fabricate rule: missing data renders
   as explicit N/A with a "don't cite this" instruction, not zeros.
2. ~~Prompt reframing~~ — done: persona is now "multi-hour to multi-day
   swings from 1h-bar microstructure — not tick scalps, not buy-and-hold";
   interval labels are accurate ("last 1h bar", "3-bar = 3 hours").
   Numeric thresholds (flow 1.2×, OI 1%, premium ±10bps) kept — on 1h bars
   they're strictly more conservative than their 15m origins; revisit only
   with live trade evidence.

## HIP-3 for AI agents (spike findings, 2026-07)

HyperTrade onboarded wallets default to HL **`unifiedAccount`** (Privy embedded
and, in practice, most in-app traders). Manual UI still uses user-signed
`sendAsset` JIT for HIP-3 in places; that was written for Standard-mode
per-dex pools and should not be copied blindly into the agent worker.

### What we proved (live, agent API wallet)

Spike scripts under `workers/ai-agent/spikes/prove-agent-send-asset/`
(`prove.ts`, `prove-xyz-order.ts`), run against a real agent row and its
master wallet on mainnet.

| Check | Result |
|---|---|
| Decrypt agent key from Supabase + trade as approved agent | OK |
| `agentSendAsset` `spot → xyz` ($1×2) | Exchange `{status:ok}`; ledger `send` rows recorded; spot USDC total dropped ~$2 |
| `clearinghouseState(dex:"xyz")` after those sends | Still `$0` accountValue / withdrawable |
| `agentSendAsset` `xyz → spot` reclaim | Rejected: `Unified account only supports sending assets through spot` |
| Tiny `xyz:TSLA` open+close (~$15) with **no** funding step, xyz CH at `$0` | **Filled** both ways — unified spot USDC margined the HIP-3 order |

HL docs ([account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)):
on unified / portfolio margin, **spot clearinghouse is the source of truth**;
**individual perp-dex user states are not meaningful**. USDC is a single pool
for validator perps, XYZ perps, and spot quote. That matches the successful
order with xyz CH at `$0`.

CoinGlass already charts Hyperliquid equity perps as `{SYMBOL}USDC` (e.g.
TSLA, NVDA) — not a “need non-CoinGlass data” hard block. Aggregates across
CEX venues may be thin; pair-level Hyperliquid series is enough for the
existing soft-skip path.

### How to read the `agentSendAsset` results (open questions)

`agentSendAsset` exists specifically so agents can move collateral without the
master key — we should **not** treat our first spike as proof it is useless or
inherently broken. Plausible gaps in our interpretation:

- **Balance visibility under unified** — expecting `clearinghouseState(xyz)` to
  show the transferred USDC was likely the wrong signal (docs say those states
  are not meaningful). Ledger + spot delta may be the real audit trail.
- **Minimum / dust / rounding** — we only tried **$1** then reclaim **$2**. A
  higher floor (e.g. $5) or different token/amount formatting might change
  reclaim or how balances surface; not re-tested yet.
- **Direction rule** — empirically `sourceDex: "spot"` worked and
  `sourceDex: "xyz"` was rejected with the “through spot” error. That may be a
  unified-only constraint (send *from* spot only), not “transfers don’t work.”
- **Standard (non-unified) accounts** — per-dex USDC pools still need funding
  for HIP-3; `agentSendAsset` is the right tool there. HyperTrade’s default is
  unified, so the agent happy path can skip funding for now. External wallets
  that somehow remain on Standard are a later UX problem (prompt to switch to
  unified if we care); do not block HIP-3 agents on that today.

Until those questions are closed, **do not** put `agentSendAsset` on the
unified HIP-3 open path (unnecessary if orders already clear; risk of confusing
ledger moves). Keep the spike for Standard-mode / reclaim experiments.

### Product direction (agents)

1. **Enable HIP-3 symbols** for agents on unified: lift adapter/UI filters,
   resolve `xyz:COIN` asset ids (`100000 + dexIndex*10000 + metaIndex`),
   monitor/reconcile with `dex`.
2. **No JIT funding** on the unified happy path — size against spot / unified
   equity like main-dex perps.
3. **CoinGlass** — reuse Hyperliquid `{COIN}USDC` venue candidates; soft-skip
   missing series.
4. **Defer** Standard-mode funding UX and any “must switch to unified” flow
   for external wallets until we see real demand.
5. Optional follow-up spike: larger `agentSendAsset` amounts, alternate read
   paths for post-transfer collateral, user-signed reclaim vs agent reclaim.

## Milestones

1. Schema + worker scaffold + adapter + key crypto ✅
2. Brain port (`executeAgentMonitoring`) + phase-1/2 scheduler + guards ✅
   (brain logic provisional — flow-first per product decision; V1 quirk:
   `flip` executes as a full close, re-entry happens on a later cycle)
3. Control plane + foundation UI ✅ — FastAPI `/api/ai-agents*` (create with
   Privy wallet-ownership check, HL-verified activate, pause/stop/dry-run,
   decisions/runs feeds; `backend/ai_agents.py` holds Node-compatible AES-GCM
   + `extraAgents` verification). Frontend: `app/ai-agents.tsx` foundation
   screen (create → approve-in-wallet → activate ceremony, shadow-mode toggle,
   decision feed), `approveNamedAgent` in hyperliquid.ts, bottom-nav AI tab
   (replaced Support). Final wizard/dashboard polish deferred by design.
4. Dedicated (sub-account) mode — **restored**. Create + unify sub +
   `sendAsset` fund; Transfer sheet for anytime moves; delete requires
   user to pull funds first (backend ≥ $1 gate). See **Agent modes**.
5. Railway: `ai-agent-worker` service (repo root `workers/ai-agent`, Dockerfile,
   1 replica, no public domain). Env: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `AGENT_KMS_KEY` (32-byte hex, SAME value on
   backend), `HL_BUILDER_ADDRESS`, `HL_BUILDER_FEE_TENTHS_BPS`, `HL_ENV=mainnet`,
   house model keys, optional `COINGLASS_HOUSE_KEY`, optional
   `HL_WEIGHT_PER_MINUTE` (default 600; ~900 on dedicated egress).
   Multi-replica safe (leader election); 1 replica is the intended shape.
   Prefer **static outbound IP** so HL's 1200 weight/min budget is not shared
   with other Railway tenants.
6. Bot badges + reasoning UX ✅ — no separate AI positions tab (copilot nets
   with manual trades). `PortfolioTabs`: robot icon + chevron → `/ai-agents`;
   Reasoning opens `AiReasoningModal`. Agent card: dedicated balance, net PnL
   (realized + live unrealized), Live Positions → portfolio; Recent Decisions
   supports per-ticker chips (`?symbol=`). APIs:
   `GET /api/ai-agents/positions`, `GET …/decisions?symbol&kind&offset`.
7. Wizard v2 ✅ — house AI keys (users bring CoinGlass for now; BYOK model keys
   kept as a wire-compatible TODO). Model catalog: gemini/gemini-3.6-flash,
   xai/grok-4.5, openai/gpt-5.6-terra, deepseek/deepseek-v4-flash,
   claude/claude-opus-5 (backend-validated registry; worker executor speaks
   OpenAI-compat + Anthropic). Asset picker with live autocomplete from
   /assets (main-dex perps only, chips confirm selection). Margin-mode option
   (cross default, per-asset isolated fallback in the adapter). No autofilled
   budget/leverage. Budget field re-worded per mode: "Max total exposure"
   (copilot) vs "Funding amount" (dedicated, = the sub-account transfer).
   Create-form floors/caps: see **Config limits** above (≤20 symbols, budget
   $100–$10M, optional per-position ≥$20).
   Dedicated toggle auto-mutes with reason via lifetime-volume check
   (`portfolio.allTime.vlm` ≥ $100k or existing sub-accounts).

   HOUSE MODEL KEY ENVS — set on the `ai-agent-worker` Railway service ONLY
   (backend never calls LLMs): `OPENAI_API_KEY`, `XAI_API_KEY`,
   `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`.

8. Live on Railway ✅ — hourly leader cycles, active agents trading mainnet.
   Remaining: UI polish, brain review, optional house CoinGlass Standard
   (remove user key from wizard), raise `HL_WEIGHT_PER_MINUTE` after dedicated
   egress.

## Env (worker)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AGENT_KMS_KEY` (32-byte hex),
`HL_BUILDER_ADDRESS`, `HL_BUILDER_FEE_TENTHS_BPS`, `HL_ENV` (mainnet|testnet),
house model keys (see milestone 7), optional `COINGLASS_HOUSE_KEY`,
optional `HL_WEIGHT_PER_MINUTE` (default `600`), optional `AGENT_CONCURRENCY`
(default `5`), optional `CYCLE_MINUTES` (default `60`), optional
`FORCE_DRY_RUN=1`.
