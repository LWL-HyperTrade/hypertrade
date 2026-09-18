# Setup guide

Step-by-step checklist to run HyperTrade locally or deploy your own fork.
Estimated time: **~45–90 minutes** if you already have Privy, Supabase, and Railway accounts.

---

## Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- [Expo dev client](https://docs.expo.dev/develop/development-builds/introduction/) (Expo Go is insufficient for Privy + native modules)
- Accounts: [Privy](https://privy.io), [Supabase](https://supabase.com), [Railway](https://railway.app) (or any Docker host)
- Optional BuilderPad web: [Vercel](https://vercel.com) for `web/` (live: [builderpad.xyz](https://builderpad.xyz))
- Arbitrum RPC URL (Alchemy, Infura, QuickNode, etc.)
- Hyperliquid **builder code** registered for your wallet (see [HL_BUILDER.md](./HL_BUILDER.md))

---

## 1. Clone and install

```bash
git clone https://github.com/YOUR_ORG/hyperrwa.git
cd hyperrwa

# Backend
cd backend
python -m venv venv
# Windows: venv\Scripts\activate
# macOS/Linux: source venv/bin/activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install

# Optional — BuilderPad web console (Vercel in prod)
cd ../web
npm install
```

---

## 2. Supabase

1. Create a new Supabase project.
2. Open **SQL Editor** and apply SQL in order (details: [DATABASE.md](./DATABASE.md)):

   | Step | File | When |
   |------|------|------|
   | A | `backend/supabase_schema.sql` | **Required** — core HL app |
   | B | `backend/migrations/ai_agents_*.sql` (ordered list in DATABASE.md) | Only if enabling AI agents |
   | C | `backend/migrations/ur_banking_v1.sql` | Only if enabling UR banking |
   | D | `backend/migrations/app_version_policy_v1.sql` | Optional — in-app update banner |
   | E | `backend/migrations/builderpad_*.sql` (order in DATABASE.md) | Optional — BuilderPad (`web/` → builderpad.xyz; branded `{slug}.builderpad.xyz`) |

3. Copy **Project URL** and **service_role** key (Settings → API).

> The mobile app does not require the Supabase anon key for core flows — the backend uses `service_role` for alerts, rewards, AI worker, and UR helpers.
>
> Do **not** assume `supabase_schema.sql` alone is enough for the full reference app: AI, UR, and `app_version_policy` are separate migration files (see [DATABASE.md](./DATABASE.md)).

---

## 3. Privy

### Env mapping (what goes where)

| Variable | Where | Required? |
|----------|--------|-----------|
| `PRIVY_APP_ID` | Backend (Railway) | **Yes** — JWT verify / JWKS |
| `PRIVY_APP_SECRET` | Backend only | Yes for wallet-ownership checks, UR link revalidation, UR test-wallet import; never ship to mobile |
| `EXPO_PUBLIC_PRIVY_APP_ID` | Expo / EAS | **Yes** — same App ID as backend |
| `EXPO_PUBLIC_PRIVY_CLIENT_ID` | Expo / EAS | **Yes** — mobile **Client** ID from Privy dashboard (not the App Secret) |

Backend does **not** use `PRIVY_CLIENT_ID`. The mobile app does — it is passed to `<PrivyProvider clientId={…}>` in `frontend/app/_layout.tsx`.

Before the OSS scrub this client ID was **hardcoded** in `AuthContext.tsx`, which is why you never needed it in Expo env. After the scrub you must set `EXPO_PUBLIC_PRIVY_CLIENT_ID` in Expo / EAS (and locally in `frontend/.env`). Find it under **App settings → Basics → Clients** for your mobile client.

`UR_TEST_PRIVY_USER_ID` / `UR_TEST_URID` (and `_2`) on **Railway** are backend QA helpers only — there is no committed Privy DID default; unset means the test-wallet import / auto-link path is inactive. The matching `EXPO_PUBLIC_UR_TEST_*` vars are optional on Expo and only needed if you want the in-app KYC-bypass / test-identity UI for those same DIDs. Production user traffic does not need them.

### Dashboard checklist (forks)

Create a Privy app, then:

1. **App settings → Basics → Domains / allowed origins**  
   Add any web origins you use (marketing site, wallet-export page, etc.). For API callbacks / partner flows that hit your backend host, include your Railway (or custom) URL **with and without** `www` if both resolve. Follow current [Privy allowed domains](https://docs.privy.io/recipes/dashboard/allowed-domains) guidance.  
   Tenant apps are `https://{slug}.builderpad.xyz`. Add all of:
   `https://builderpad.xyz`, `https://www.builderpad.xyz`, `https://*.builderpad.xyz`.
   The Vite console (`web/`, port 5173) needs `http://localhost:5173` here. OAuth return is `{origin}/login`.
   For social login on every slug subdomain, leave **OAuth redirect URLs** empty (Privy wildcards are not supported on that list) or you must add each host. Allowed origins wildcards **are** supported.

2. **App settings → Basics → Clients**  
   Create a **mobile** app client ([app clients](https://docs.privy.io/basics/get-started/dashboard/app-clients)). React Native **requires** a client. Set:
   - **Allowed app identifiers** to your Android `package` and iOS `bundleIdentifier` from `frontend/app.json` (e.g. `com.hypertrade.app` / `com.exchange.hypertrade` — change these when you fork). An empty list denies mobile requests.
   - **Allowed URL schemes** to your Expo `scheme` (e.g. `hypertrade` — must match `app.json`) for OAuth / deeplink returns.

3. **Embedded wallets on login**  
   Enable automatic **EVM** embedded wallet creation in the Privy dashboard (User management / Authentication — wording may vary). In code, HyperTrade sets `config.embedded.ethereum.createOnLogin: 'users-without-wallets'` on `PrivyProvider` ([Privy RN docs](https://docs.privy.io/basics/react-native/advanced/automatic-wallet-creation)). Both dashboard + this SDK flag matter so new users get an EOA for Bridge2 / HL / UR.

4. Enable the login methods you want (email, Google, Apple, etc.) and configure OAuth redirect URLs as Privy requires for those providers.

5. Copy **App ID** → `PRIVY_APP_ID` (Railway) + `EXPO_PUBLIC_PRIVY_APP_ID` (Expo).  
   Copy the mobile **Client ID** → `EXPO_PUBLIC_PRIVY_CLIENT_ID` only.  
   Copy **App Secret** → `PRIVY_APP_SECRET` on Railway only (never `EXPO_PUBLIC_*`).

Watch the [Privy React Native changelog](https://docs.privy.io/changelogs/react-native) for `@privy-io/expo` fixes (iOS background, wallet reconnect, and similar). Same “stay current” list as HL / tradeXYZ: [HL_BUILDER.md](./HL_BUILDER.md#stay-current-api--listings--wallet-sdk).

---


## 4. Backend environment

```bash
cp backend/.env.example backend/.env
# Edit backend/.env — see docs/ENVIRONMENT.md
```

**Minimum to start API:**

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
PRIVY_APP_ID=your-privy-app-id
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/KEY
BRIDGE2_RELAYER_PRIVATE_KEY=0x...   # hot wallet — fund with ETH on Arbitrum
```

Run locally:

```bash
cd backend
uvicorn server:app --reload --port 8000
```

Health check: `GET http://localhost:8000/api/health`

Deploy to Railway: connect repo, set root to `backend/`, use `backend/Dockerfile`, add the same env vars in the Railway dashboard.

---

## 5. Relayer wallet (Bridge2 deposits)

1. Generate a **dedicated** EOA (not your builder wallet).
2. Set `BRIDGE2_RELAYER_PRIVATE_KEY` in backend env.
3. Send **ETH on Arbitrum** to that address for gas.
4. Users sign USDC **EIP-2612 permits** in the app; your backend submits `permit` + `deposit` to Bridge2.

Without a funded relayer, deposits fail at submission time.

---

## 6. Builder configuration

The repo ships with the **HyperTrade reference builder address/fee hardcoded** as defaults (backend + frontend). That means a fork that never changes them will attach HyperTrade’s builder on orders.

The mobile app **pins** the order builder from `EXPO_PUBLIC_HL_BUILDER_ADDRESS` (else that hardcoded default). `/api/builder-config` still supplies fee discounts, but cannot redirect fees to a different address.

To earn fees on **your** builder code:

1. Set frontend `EXPO_PUBLIC_HL_BUILDER_ADDRESS` / `EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS` in `frontend/.env` **and** EAS env for release builds
2. Set matching backend `BUILDER_ADDRESS` / `BUILDER_FEE` (and AI worker `HL_BUILDER_*` if used)
3. Or replace the hardcoded defaults in `server.py`, `hyperliquid.ts`, and `BuilderConfigProvider.tsx`

Also register as an HL builder.

Details: [HL_BUILDER.md](./HL_BUILDER.md) · [FORKING.md](./FORKING.md) · [ENVIRONMENT.md](./ENVIRONMENT.md)

---

## 7. Frontend environment

```bash
cp frontend/.env.example frontend/.env
```

```env
EXPO_PUBLIC_BACKEND_URL=http://YOUR_LAN_IP:8000   # or Railway URL
EXPO_PUBLIC_ARBITRUM_RPC_URL=https://arb-mainnet...
EXPO_PUBLIC_PRIVY_APP_ID=your-privy-app-id
EXPO_PUBLIC_PRIVY_CLIENT_ID=your-privy-client-id

# Forks earning your own builder fees (also set in EAS for release builds):
# EXPO_PUBLIC_HL_BUILDER_ADDRESS=0xYourBuilderAddress
# EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS=30
```

Optional RPC / AppsFlyer / WalletConnect / SIWE / builder vars: see `frontend/.env.example` (do **not** commit secrets into `app.json`).

Firebase push: copy `GoogleService-Info.plist.example` → `GoogleService-Info.plist` and `google-services.json.example` → `google-services.json`, then replace with files from your Firebase console (those real files are gitignored).

Run:

```bash
cd frontend
npx expo start --dev-client
```

---

## 8. Optional — demo / testnet mode

For Apple review or sandbox onboarding, configure on the **backend**:

```env
HL_TESTNET_MASTER_PK=0x...          # testnet-only hot wallet
DEMO_GRANT_AMOUNT_USDC=100
```

The app switches HL endpoints via `frontend/src/lib/hlEnv.ts` when demo mode is active in the UI.

---

## 9. Optional — market data keys

| Feature | Key |
|---------|-----|
| Stock news / fundamentals | `FINNHUB_KEY` |
| Alpha Vantage | `ALPHAVANTAGE_KEY` |
| FX display | `FOREXRATE_KEY` |
| AI asset blurbs | `GEMINI_API_KEY` |

Missing keys degrade gracefully — core trading still works.

---

## 10. Optional — push notifications

1. Create a Firebase project.
2. Add iOS + Android apps; download `GoogleService-Info.plist` and `google-services.json` into `frontend/` (gitignored — start from the `*.example` files).
3. Configure Expo notifications + EAS credentials.

### Firebase client files vs Expo “Google Service Account Keys”

These are **different** things:

| Artifact | What it is | Where it lives |
|----------|------------|----------------|
| `frontend/google-services.json` | **Android Firebase client config** (project id, mobilesdk app id, Android API key) for `@react-native-firebase/*` | Downloaded from [Firebase Console](https://console.firebase.google.com/) → Project settings → Your apps → Android app |
| `frontend/GoogleService-Info.plist` | **iOS Firebase client config** | Same console → iOS app |
| Expo **Google Service Account Keys** (e.g. `firebase-cloud-messaging-api@….iam.gserviceaccount.com`, `firebase-adminsdk@…`, `play-console-…@…`) | **Server/CI credentials** uploaded under Expo → Project settings → Credentials — used by EAS for FCM / Play submit / admin APIs | **Not** a substitute for the plist/json in `frontend/` |

The FCM service-account key you see in Expo Credentials is **not** the same as `google-services.json`. You need **both** for a typical HyperTrade-style setup: client files in the app project for the native Firebase SDK, and (separately) Expo Google keys for cloud messaging / store automation.

**What you should do (HyperTrade maintainer):**

1. **Keep** your real `google-services.json` and `GoogleService-Info.plist` on disk under `frontend/` (they are gitignored — don’t delete them).
2. **Do not** commit them to the public repo (examples stay committed).
3. **EAS cloud builds** only upload **git-tracked** files. If you see `"google-services.json" is missing`, use one of:

   **A — Temporary force-track (fastest for a one-off build):**
   ```bash
   cd frontend
   git add -f google-services.json GoogleService-Info.plist
   eas build -p android --profile production
   # after the build is queued, untrack again (files stay on disk):
   git rm --cached google-services.json GoogleService-Info.plist
   ```
   Do **not** push a commit that includes the real Firebase client files.

   **B — EAS file env (better long-term, no git track):** create a [file environment variable](https://docs.expo.dev/eas/environment-variables/#file-environment-variables) (e.g. `GOOGLE_SERVICES_JSON`) and point `android.googleServicesFile` at that path via `app.config.js` / `app.config.ts` (`process.env.GOOGLE_SERVICES_JSON`). Same idea for the iOS plist.

   `eas build --local` uses your disk copy and does not need the file to be tracked.
4. Leave existing Expo Google Service Account Keys alone if FCM / Play submit already work — those stay in Expo Credentials.

**Forks:** create their own Firebase project → download their own plist/json → set their own Expo credentials.

### Expo application identifier

Under **Expo → Project settings → Credentials → Android**, set **Application identifier** to the same Android `package` as `frontend/app.json` (e.g. `com.hypertrade.app`). iOS bundle id must match `ios.bundleIdentifier` (e.g. `com.exchange.hypertrade`). Forks must change both `app.json` and Expo credentials when they rebrand.

---

## 11. Optional — AI agents (Tier 2)

Skip unless you want the trading agent worker (builds on Tier 1 / Hyperliquid).

Supports **Shared** (main wallet) and **Dedicated** (HL sub-accounts, volume-gated). Details: [AI_AGENTS.md](./AI_AGENTS.md).

1. Apply AI migrations (see [DATABASE.md](./DATABASE.md)).
2. Deploy `workers/ai-agent` (Railway Dockerfile in that folder): copy `workers/ai-agent/.env.example`, set the same `SUPABASE_*` + `AGENT_KMS_KEY` as the backend, plus `HL_BUILDER_*`, CoinGlass/Massive, and at least one LLM key.
3. Backend control plane is already in FastAPI (`/api/ai-agents*`) once tables exist.

Fork guide: [AI_AGENTS.md](./AI_AGENTS.md).

---

## 12. Optional — Neobank / UR banking (Tier 3)

Skip unless you have UR.APP partner credentials.

**Partner ID:** offering IBAN/card (neobank-style) rails requires an **active UR partner ID**. That always means **manual onboarding with the UR team** (process, fees, and technical steps can change). Crypto on–off ramps may be under maintenance while fiat / FX / P2P still work — check [@Fiat24Official](https://x.com/Fiat24Official) and [BANKING_UR.md](./BANKING_UR.md). This reference uses **Card Mode: Fiat Only** (not Crypto Backed) — confirm with UR when onboarding. Docs / sandbox: [https://docs.ur.app/](https://docs.ur.app/). Also [FORKING.md](./FORKING.md), [AGENTS.md](../AGENTS.md).

1. Apply `backend/migrations/ur_banking_v1.sql` ([DATABASE.md](./DATABASE.md)).
2. Configure UR partner / signer / relayer env — [BANKING_UR.md](./BANKING_UR.md).
3. Banking UI lives under `frontend/src/components/bank/` and `frontend/src/lib/urApi.ts`.

---

## 13. Optional — BuilderPad (`web/` on Vercel)

Skip unless you want the **web** product: a console at builderpad.xyz where creators publish branded Hyperliquid trading apps. This is not a Pons-only site; the token launch is an optional wizard chapter. Details: [BUILDERPAD.md](./BUILDERPAD.md).

1. Apply BuilderPad SQL ([DATABASE.md](./DATABASE.md) §5).
2. `cd web && npm install && npm run dev` → `http://localhost:5173`. Set `VITE_PRIVY_APP_ID` (same App ID as the backend). Empty `VITE_BACKEND_URL` uses the Vite `/api` proxy to local FastAPI. Full `VITE_*` list: [ENVIRONMENT.md](./ENVIRONMENT.md).
3. Privy: allow `http://localhost:5173` and `https://builderpad.xyz` (plus `https://*.builderpad.xyz`). Use a Privy **Web** client ID if you set `VITE_PRIVY_CLIENT_ID` — never the Expo client.
4. Production: deploy `web/` to **Vercel** (SPA rewrites in `web/vercel.json`). Point the project at the same backend `VITE_BACKEND_URL` as Railway. Creator hosts `{slug}.builderpad.xyz` need `BUILDERPAD_VERCEL_TOKEN` on the backend.

Pons contracts (`contracts/pons-v2/`) are only required if you keep the coin chapter — [PONS_FORK.md](./PONS_FORK.md).

---

## Smoke test checklist

### Tier 1 (required)

- [ ] Privy login (email or OAuth)
- [ ] Embedded wallet created
- [ ] HL agent approval flow completes
- [ ] USDC deposit via Bridge2 permit
- [ ] Place and fill a small perp or spot order with builder fee attached
- [ ] Portfolio shows position; WS account stream updates
- [ ] `GET /api/builder-config` returns your builder address

### Optional

- [ ] Demo mode: testnet grant lands (`demo_funding`) — only if `HL_TESTNET_MASTER_PK` set
- [ ] AI: create agent in shadow/dry-run, see a decision row — only if worker + AI SQL applied
- [ ] UR: KYC / banking entry opens without 500s — only if UR DDL + partner env present
- [ ] BuilderPad: `web/` login at `/login`, create/publish an app, branded desk at `/t/{slug}` (or `{slug}.builderpad.xyz`) — only if tenant SQL + `VITE_PRIVY_APP_ID`

---

## Next steps

- [HL builder integration](./HL_BUILDER.md)
- [Database / Supabase](./DATABASE.md)
- [Environment reference](./ENVIRONMENT.md)
- [Roadmap](./ROADMAP.md)
- [BuilderPad web product](./BUILDERPAD.md)
- [Mobile store compliance](./MOBILE_RELEASE.md)
