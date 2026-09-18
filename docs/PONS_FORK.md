# Pons v2 fork — spec and verified mapping

Working reference for forking the Pons v2 launchpad to our own deployment on
**Robinhood Chain (4663)**. This is the **optional coin chapter** of BuilderPad
(`web/` at [builderpad.xyz](https://builderpad.xyz)), not the BuilderPad product
itself — the product is branded Hyperliquid web apps. Architecture stays intact;
only the economics below change. HyperEVM is out of scope for now (no Uniswap v4
there; v4-core is BUSL-1.1 until 2027-06-15).

Public-facing product docs (lifecycle, fees, contracts): **`https://builderpad.xyz/docs`**. This file stays the engineer / deploy source of truth.

Sources of truth used: `github.com/ponsdotdev/ponsfamily` (`contractsV2/src/v2`,
MIT), `docs.ponsfamily.com/v2`, Blockscout verified sources, live reads via
Alchemy `eth_call` on 4663 (2026-09-13). Do not trust anything here that is not
re-verified against those before deploy.

---

## 1. Economics (target)

| Knob | Target | Pons live (probed) | Where it lives | Code change? |
|---|---|---|---|---|
| Launch fee | `0.00025 ETH` | `0.0005 ETH` | `PonsV2LaunchFactory` ctor `initialLaunchFee` / `setLaunchFee` | No — config |
| Curve trade fee | `75 bps` | `100 bps` | `LaunchConfig.curveFeeBps` (`addLaunchConfig`) | No — config |
| Creator tax default | `0` | `0` | Per-launch `TokenParams.creatorTaxBps` (UI default) | No |
| Creator tax cap | `1000 bps` | `1000 bps` | `factory.setMaxCreatorTaxBps` (ceiling const `MAX_CREATOR_TAX_CEILING_BPS = 1000`) | No |
| Protocol share | `10%` → `1000 bps` | `3000 bps` | `hook.setProtocolFeeShareBps` (cap `MAX_PROTOCOL_FEE_SHARE_BPS = 5000`) | No — config |
| Creator share | `90%` | `70%` | Derived: `feeAmount âˆ’ protocol` | No |
| Buyback default | `OFF` | UI default `true` | Per-launch `TokenParams.buybackEnabled`; **web default in `web/src/ui/CoinTermsFields.tsx:34` must flip to `false`** | Web only |
| Buyback slice (when on) | `25%` of creator bucket → `2500 bps` | `5000 bps` | `hook.setBuybackBurnBps` (cap `BASIS_POINTS`) | No — config |
| V4 pool fee | `0` | `0` | `LaunchConfig.poolFee` | No |
| V4 hook fee | `75 bps` | `100 bps` | `hook.setHookFeeBps` (cap `MAX_HOOK_FEE_BPS = 1000`) | No — config |
| Snipe tax | same as Pons | start `9900 bps`, window **`3 s`** (source default is 15 s; owner lowered it live) | `factory.setSnipeTaxStartBps` / `setSnipeTaxSeconds` | No — config; **decide 3 s (live) vs 15 s (source)** |
| Graduation | same as Pons | threshold `4.2 ETH`, phantomQuote `1.68 ETH`, supply `1e9`, tickSpacing `200` | `LaunchConfig` | No |

Fee-split semantics (identical pre/post graduation, snapshotted per launch at
creation from the hook's `IPonsV2FeePolicy`):

```
fee          = amount * feeBps / 10_000            // curve: feeBps; hook: hookFeeBps
protocol     = fee * protocolFeeShareBps / 10_000  // 10%
creatorSlice = fee - protocol                      // 90%
buyback      = buybackEnabled ? creatorSlice * buybackBurnBps / 10_000 : 0   // 25% of the 90%
creatorTax   = amount * creatorTaxBps / 10_000     // separate, 100% to creator
```

Guardrails in source that the targets satisfy: `MAX_CURVE_FEE_BPS = 1000`,
`MAX_TOTAL_TRADE_FEE_BPS = 2000` (75 + 1000 = 1075 OK on both curve and hook).

**Result: zero Solidity changes to fee logic.** All economics are constructor
args + owner setters + one launch config. Put them in one constants file in the
deploy scripts (no magic numbers).

---

## 2. Project: `contracts/pons-v2/` (Foundry)

Installed `forge 1.5.1` user-local (`%USERPROFILE%\.foundry\bin`; add to PATH).
Compiler settings match the Blockscout-verified live deployment: **solc 0.8.35,
cancun, optimizer 200, via-IR** (`foundry.toml`).

```
contracts/pons-v2/
  src/                     vendored Pons v2 sources (identifier-renamed to BuilderPad*) + BuilderPadFeeEscrow.sol (ours)
  lib/                     openzeppelin-contracts (v5), v4-core, v4-periphery (+permit2), v4-hooks-public, forge-std
  script/Config.sol        every number/address of the fork (economics, Uniswap addrs, pair tokens)
  script/StackDeployer.sol deploy / wire / assert — shared by script and fork tests
  script/Deploy.s.sol      broadcast entrypoint; writes deployments/<chainId>.json
  script/HookMiner.sol     CREATE2 salt mining for the hook address flags
  test/FeeEscrow.t.sol     34 unit + fuzz tests
  test/FeeEscrow.invariant.t.sol   4 invariants (conservation, auth, over-claim)
  test/Fork.Lifecycle.t.sol        Robinhood fork: launch → trade → sweep → graduate → v4 swap
  UPSTREAM.txt             provenance
```

### Source provenance — important finding

The GitHub repo (`ponsdotdev/ponsfamily`, commit `79e99ef`) is **behind the live
deployment**. Diffing against the Blockscout-verified bundle of
`PonsV2LaunchAndBuy` (87 files, compiled against the live factory):

| File | GitHub vs verified |
|---|---|
| `PonsV2LaunchFactory.sol` | identical (whitespace only) |
| `PonsV2BondingCurve.sol` | verified is **+100 lines**: snipe tax (`currentSnipeTaxBps`, `IPonsV2SnipeTax`) — our web app reads this |
| `PonsV2LaunchDeployer.sol` | verified uses **CREATE2 with creator `salt`** (+`predictLaunchAddresses`) — our web app passes `TokenParams.salt` |
| `ILaunchpadV2.sol` | verified adds `IPonsV2SnipeTax` |
| hook / vault / locker / executor / guard / token / math | identical |
| OZ / v4 libs | verified is a newer OZ (adds `Create2`, `Errors`, `LowLevelCall`) |

We vendored the **verified** sources. Not available anywhere as source:
`PonsV2FeeEscrow` (only the interface) — written by us (§3).

### Licences

`contracts/pons-v2/LICENSE` is the map: our files and the forked Pons files are
MIT (Pons copyright notice retained; upstream carries SPDX headers, no root
LICENSE file at the vendored commit); `lib/` is MIT except Uniswap v4-core
`Pool.sol` + `Position.sol` (BUSL-1.1, change date 2027-06-15) which are
linked into the guard/hook exactly as upstream Pons does. Nothing from v4-core
is redeployed — pools run on Uniswap's official PoolManager on 4663.

### Naming — `BuilderPad*` (2026-09-14)

Contracts are named `BuilderPad<Role>` (`BuilderPadLaunchFactory`,
`BuilderPadFeeEscrow`, …). The first deploy (v1, `4663.v1-ponsv2-names.json`)
kept upstream `PonsV2*` names; they were renamed before the v2 deploy so
explorers do not show two stacks with identical contract names and token
pages do not read "PonsV2LauncherToken". This is an identifier-only rename
(`PonsV2` → `BuilderPad` in identifiers, file names, and the interface
names in `ILaunchpadV2.sol`); ABI, selectors, events, errors and runtime
bytecode are unchanged (sizes identical, factory still 24,177 B). Upstream
provenance lives in `UPSTREAM.txt`; diff against upstream with
`sed 's/BuilderPad/PonsV2/g'`. Below, `PonsV2*` refers to the **official**
Pons contracts / upstream sources, `BuilderPad*` to ours.

### Contract stack and constructors

| # | Contract | Constructor | Notes |
|---|---|---|---|
| 1 | `BuilderPadLaunchLocker` | `(owner, positionManager)` | |
| 2 | `BuilderPadFeeEscrow` | `(owner)` | ours; wiring: `setFactory`, `setHook`, `setBuybackVault` (one-time each) |
| 3 | `BuilderPadMemeHook` | `(poolManager, feeEscrow, protocolFeeRecipient, owner)` | CREATE2 salt-mined; flags `beforeInitialize + afterSwap + afterSwapReturnDelta`. Ctor defaults 3000/5000/100 overridden by setters |
| 4 | `BuilderPadBuybackVault` | `(owner, feePolicy = hook, feeEscrow)` | |
| 5 | `BuilderPadLaunchFactory` | `(owner, poolManager, positionManager, permit2, locker, hook, feeEscrow, vault, 0.00025 ether)` | **deploys `BuilderPadGraduationGuard` in its constructor** |
| 6 | `BuilderPadLaunchDeployer` | `(factory)` | |
| 7 | `BuilderPadGraduationExecutor` | `(positionManager, permit2, locker, factory)` | |
| 8 | `BuilderPadGraduationGuard` | — | created by the factory (read `factory.graduationGuard()`) |
| 9 | `BuilderPadLaunchAndBuy` | `(factory, owner)` | source from Blockscout verification |
| — | `BuilderPadBondingCurve`, `BuilderPadLauncherToken` | per launch | created by `LaunchDeployer` on every `launchToken` |

Runtime sizes (bytes, EIP-170 limit 24,576): factory **24,177** (399 margin —
do not touch), deployer 20,906, hook 15,167, curve 10,229, vault 4,602,
executor 4,402, launchAndBuy 4,416, escrow 3,853, guard 2,896, locker 1,969.

External (Uniswap official on 4663, reused): PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951`, PositionManager
`0x58daec3116aae6D93017bAAea7749052E8a04fA7`, Permit2
`0x000000000022D473030F116dDEE9F6B43aC78BA3`. CREATE2 deployer
`0x4e59b44847b379578588920cA78FbF26c0B4956C` confirmed present on 4663 and 46630.

---

## 3. `BuilderPadFeeEscrow` (ours)

Implements `IBuilderPadFeeEscrow` (upstream `IPonsV2FeeEscrow`) exactly as the curve, hook and vault call it:
`credit(recipient)` payable, `creditToken(recipient, token, amount)` (pulls via
`transferFrom`, credits what actually arrived), `claim()`, `claim(amount)`,
`claimToken(token)`, `claimToken(token, amount)`, `balanceOf`, `balanceOfToken`.

Authorization mirrors `PonsV2BuybackVault._isAuthorizedLocker`: hook and vault
trusted directly (one-time owner wiring); a curve proves itself by reporting
`token()` and the factory's `getLaunchedToken(token).curve` must equal the
caller. No per-launch admin action. Owner cannot renounce; `Ownable2Step`.

Nothing else: no `receive()` (stray ETH rejected), no arbitrary calls, swaps,
upgradeability or admin withdrawals. `totalNative` / `totalToken[token]` are
public so `balance >= total` can be checked externally.

Tests (`forge test --match-path "test/FeeEscrow*"`): 38/38 —
wiring one-time + onlyOwner, auth (hook, vault, curve, EOA, owner, lying curve,
unknown token, reverting `token()`, record change, unwired), ETH and ERC-20
credit/claim full/partial/over/zero, reentrancy (blocked), rejecting recipient
(only blocks itself), fee-on-transfer token (credits received), independent
ledgers, fuzz conservation; invariants over 256 runs × 64 depth: ETH held ==
`totalNative` == Σ balances, per-token same, no unauthorized success, claimed ≤
credited.

---

## 4. Deploy

Owner == broadcaster (all wiring is `onlyOwner`). Never put a key in a file;
use a Foundry keystore account (`cast wallet import`). Product context for
BuilderPad (without repeating this spec): [BUILDERPAD.md](./BUILDERPAD.md).

Editor “Source … not found” on OpenZeppelin / v4 imports is the Solidity
extension, not a compile error. Do not edit the contracts. `forge` uses
`foundry.toml` remappings. Reload the window if squiggles remain.

### Where env lives (not `web/`)

`ROBINHOOD_RPC_URL` for Foundry is **not** the Vite var. Three places:

| File / env | Variable | Role |
|---|---|---|
| `backend/.env` / Railway | `ROBINHOOD_RPC_URL` | FastAPI Pons reads |
| `web/.env` | `VITE_ROBINHOOD_RPC_URL` | Browser Pons / Privy |
| `contracts/pons-v2/.env` **or** the PowerShell session | `ROBINHOOD_RPC_URL` | Foundry default (`eth_rpc_url` alias `robinhood`) |

Foundry's project root is **`contracts/pons-v2/`**, not the repo root and not
`web/`. Put `ROBINHOOD_RPC_URL` in **`contracts/pons-v2/.env`** — that is the
main RPC for `forge script` / `forge test`. Never commit that file.

Fallback if the var is unset: `--rpc-url robinhood_public` (Robinhood's public
endpoint; slower). See [ENVIRONMENT.md](./ENVIRONMENT.md).

### `cast wallet import` — any directory

The keystore is **user-global** (`%USERPROFILE%\.foundry\keystores` on Windows),
not per-repo. `deployer` is the account **name**, not a folder.

You can run the import from anywhere as long as `cast` is on PATH. Habit is
to do it from `contracts\pons-v2` because `forge script` must run there next.

```powershell
$env:PATH="$env:USERPROFILE\.foundry\bin;$env:PATH"
cd contracts\pons-v2
cast wallet import deployer --interactive
# paste the private key when prompted; it is stored encrypted in the keystore
```

Then `forge script … --account deployer --sender 0x29a1…23EB`. `--sender` must
be the address of that key.

```powershell
$env:PATH="$env:USERPROFILE\.foundry\bin;$env:PATH"
cd contracts\pons-v2

# dry run (simulates deploy + wiring + asserts against live state; no key needed)
# uses ROBINHOOD_RPC_URL from contracts/pons-v2/.env via alias `robinhood`
forge script script/Deploy.s.sol:Deploy --rpc-url robinhood --sender 0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB

# real — verify on Sourcify (Blockscout's /api is behind a Cloudflare challenge; see below)
forge script script/Deploy.s.sol:Deploy --rpc-url robinhood `
  --account deployer --sender 0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB --broadcast `
  --verify --verifier sourcify

# if ROBINHOOD_RPC_URL is unset: `--rpc-url robinhood_public`
```

Dry run against live Robinhood state (2026-09-13, re-run 2026-09-14 with
`BuilderPad*` names): all 9 deploy, 17 pair tokens approve, every config
assert passes. **Estimated gas ≈ 30.0M at 0.17 gwei ≈ 0.005 ETH.** Fund the
deployer with ~0.02 ETH.

After a real deploy: `deployments/4663.json` is overwritten. Then swap the
addresses in `web/src/lib/pons/chain.ts` + `backend/pons.py`, redeploy both,
and clear `tenants.coin_*` for any test launch made on the previous stack
(§6) — a token launched on stack N does not exist on stack N+1.

Order (as executed by `StackDeployer.deployStack`):
locker → escrow → hook (CREATE2) → vault → factory (+guard) → deployer →
executor → launchAndBuy.

Wiring (`StackDeployer.wireStack`):
`escrow.setFactory/setHook/setBuybackVault`; `locker.setFactory`;
`vault.setFactory`; `hook.setFactory`, `hook.setBuybackVault`;
`hook.setProtocolFeeShareBps(1000)`, `setBuybackBurnBps(2500)`,
`setHookFeeBps(75)`, `setMaxInternalPriceImpactBps(300)`;
`factory.setLaunchDeployer`, `setGraduationExecutor`,
`setLaunchForwarder(launchAndBuy)`; `factory.addLaunchConfig({1e27, 75,
1.68e18, 4.2e18, 0, 200, true})` → id 0; `setMaxCreatorTaxBps(1000)`;
`setSnipeTaxStartBps(9900)`, `setSnipeTaxSeconds(3)`; per pair token
`setPairTokenEconomics` + `setPairTokenApproved(true)`; `setLaunchEnabled(true)`.

The hook constructor sets `feeSweepOperator = owner` and
`protocolFeeRecipient` from the argument, so no extra call is needed.

Output: `deployments/4663.json` (all addresses + externals). Post-deploy,
re-run the dry run's asserts anytime via `assertStack` (fork test does this).

### Deployed v2 — Robinhood Chain 4663 (2026-09-14, `BuilderPad*` names) — **CURRENT**

Record: `deployments/4663.json`. Broadcast **61 txs, all `status 0x1`**
(8 creates + guard from the factory ctor + 53 wiring calls incl. 17 pair
tokens and `setLaunchEnabled(true)`), first block `62300555`. Owner / deployer
/ protocol fee recipient = `0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB`.
Web (`chain.ts`) and backend (`pons.py`) point here.

| # | Contract | Address | Deploy tx |
|---|---|---|---|
| 1 | `BuilderPadLaunchLocker` | `0xCf303d2B2Cc71d70Aa3795549FD6499Dfb6005f0` | `0xd5ff76d0…3a92d9` |
| 2 | `BuilderPadFeeEscrow` (ours) | `0x2F97d17Aba64bA843EFccAd5479ff8d35Be097d2` | `0x7d0bb755…eb83db` |
| 3 | `BuilderPadMemeHook` (CREATE2) | `0x4d491Fc6F68ca152AEe5ab2A39e5f3Ac9fa1E044` | `0xec665aed…861ef6` |
| 4 | `BuilderPadBuybackVault` | `0x095f3F9AD577E5d7564e2527717deBBbAAf5F303` | `0x11ebc07b…e83d04` |
| 5 | `BuilderPadLaunchFactory` | `0x519580283eAEabF01d5Db061862d180c4596e709` | `0xe761ba90…9cbb8d` |
| 6 | `BuilderPadGraduationGuard` (from factory ctor) | `0xEA131a64B550136F43870b3134640bFed2d0305e` | same as 5 |
| 7 | `BuilderPadLaunchDeployer` | `0xa7e1B5f729d8E15fCF64a3C7aA6fD17794E2c2cf` | `0x3e4d712e…3f6fa0` |
| 8 | `BuilderPadGraduationExecutor` | `0x17F09C3187583276826Ba138F151D268EB88F547` | `0x6b5068d5…b8ed06` |
| 9 | `BuilderPadLaunchAndBuy` | `0x9824953E1b8aA71Da182356776f54949eb8774CC` | `0x62dd123d…8dd4cf` |

Post-deploy reads (2026-09-14): `launchFee = 0.00025 ETH`, `launchEnabled =
true`, `maxCreatorTaxBps = 1000`, hook `hookFeeBps 75 / protocolFeeShareBps
1000 / buybackBurnBps 2500`, escrow wired to factory/hook/vault, USDG approved.

**Sourcify: all 9 `exact_match`** (runtime) — `https://sourcify.dev/server/v2/contract/4663/<address>`.
Four (locker, escrow, hook, vault) were submitted by `forge script --verify
--verifier sourcify` before the run was interrupted; the other five via
`forge verify-contract … --verifier sourcify` afterwards. Blockscout shows
sources only if the Robinhood instance imports from Sourcify (their side).

Verify a per-launch curve + token once after the first v2 launch:
`forge verify-contract <curve> src/BuilderPadBondingCurve.sol:BuilderPadBondingCurve --chain 4663 --verifier sourcify`
and the same for `src/BuilderPadLauncherToken.sol:BuilderPadLauncherToken`.

### Deployed v1 — Robinhood Chain 4663 (2026-09-13, `PonsV2*` names) — superseded

Record: `deployments/4663.v1-ponsv2-names.json`. Superseded by v2; v1 stays
live on-chain (immutable) but web/backend no longer point at it. Test launch
`FORKTEST` (`0x46d69a08…AFbe`) lives on v1 only; its `tenants.coin_*` row was
cleared on 2026-09-14 so `105-test` can launch again on v2.

Broadcast (v1): **61 txs, all `status 0x1`** (8 creates + guard from the
factory ctor + 53 wiring calls incl. 17 pair tokens and
`setLaunchEnabled(true)`). Owner / deployer / protocol fee recipient =
`0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB`.

| # | Contract | Address | Deploy tx |
|---|---|---|---|
| 1 | `PonsV2LaunchLocker` | `0x8A80646d8dBa250D49085c02c141f7573Bd689dB` | `0x580ad1c8…586a9c` |
| 2 | `PonsV2FeeEscrow` (ours) | `0x56ACEd81Ec9DD950A3B77710CaAc54eCdaE49Ee7` | `0x8f6fe911…afcdcd` |
| 3 | `PonsV2MemeHook` (CREATE2) | `0xA3BF0fa54fF310F081B052626BAac101bCA9e044` | `0x52aa590d…521b92` |
| 4 | `PonsV2BuybackVault` | `0x8f3aBb6E5fFB9156A1D285632a29A50Cbc3Ea1c1` | `0x2f2840c8…9d1b65` |
| 5 | `PonsV2LaunchFactory` | `0x1ef3bAD2F8fF2C37F6147b30d881033749cbB558` | `0xfce878b6…18a2a3` |
| 6 | `PonsV2GraduationGuard` (from factory ctor) | `0xabb201885bb6Cb53cfa8F1F7919D3DAD8729c96b` | same as 5 |
| 7 | `PonsV2LaunchDeployer` | `0xddfb6828592EBD1B14fecA84600a8d57C20db520` | `0xc6155929…e48bd3` |
| 8 | `PonsV2GraduationExecutor` | `0xe0423dB496e898b2a53027a3815639A847A57f3c` | `0xe096dbd2…4f95ca` |
| 9 | `PonsV2LaunchAndBuy` | `0xBf7d069454608912F42D2d601822127818705fa3` | `0x88b35316…a60e29` |

Externals reused: PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`,
PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7`, Permit2
`0x000000000022D473030F116dDEE9F6B43aC78BA3`.

Hook address ends in `…e044` — the CREATE2-mined flag bits
(`beforeInitialize + afterSwap + afterSwapReturnDelta`) are in the low 14 bits,
same as the official hook `…Be044`.

### Source verification — use Sourcify

`robinhoodchain.blockscout.com/api` sits behind a Cloudflare **managed
challenge**. Every non-browser client gets the `Just a moment…` HTML — forge
(`--verifier blockscout`), plain HTTPS with a browser User-Agent, and even
Sourcify's own server-to-server push (its job log shows the same 403). Forge
retries 5 s × 4 per contract, which looks like an infinite loop after a
deploy. Ctrl+C there stops only verification; on-chain state is unaffected.

**Sourcify lists Robinhood Chain (4663) and works.** Tested 2026-09-14 on the
v1 escrow: `forge verify-contract 0x56ACEd81… src/…FeeEscrow.sol:…FeeEscrow
--chain 4663 --verifier sourcify` → `exact_match` (runtime), public at
`https://sourcify.dev/server/v2/contract/4663/<address>` and in the Sourcify
repo UI. Blockscout can import Sourcify matches on its side; whether the
Robinhood instance does is up to them — not something we can force.

Procedure for the `BuilderPad*` deploy:

1. Deploy with `--verify --verifier sourcify` (command above). Forge submits
   all 9 (+ guard) after broadcast.
2. Any that miss (Sourcify rate limits), one at a time:
   ```powershell
   cd contracts\pons-v2
   forge verify-contract <addr> src/BuilderPadLaunchFactory.sol:BuilderPadLaunchFactory --chain 4663 --verifier sourcify
   ```
   Sourcify matches by metadata hash, so no `--constructor-args` are needed.
   The guard is created by the factory ctor — verify it the same way with
   `src/BuilderPadGraduationGuard.sol:BuilderPadGraduationGuard`.
3. Per-launch `BuilderPadBondingCurve` / `BuilderPadLauncherToken` contracts
   are the same bytecode every launch; verify one of each once and Sourcify
   serves every later instance as a match.
4. Blockscout manual fallback if ever needed: contract → *Verify & publish* →
   **Standard JSON input**; generate with
   `forge verify-contract <addr> <path:Name> --show-standard-json-input > <Name>.json`.
   Compiler `0.8.35`, EVM `cancun`, optimizer on / 200, via-IR on.

---

## 5. Verification results

| Suite | Result |
|---|---|
| `forge build` | clean, all 9 under EIP-170 |
| `test/FeeEscrow.t.sol` | 34/34 |
| `test/FeeEscrow.invariant.t.sol` | 4/4 (16,384 calls each) |
| `test/Fork.Lifecycle.t.sol` (live Robinhood fork) | see below |

Re-run 2026-09-14 after the `BuilderPad*` rename: 45/45 again. One invariant
run flagged `eth balance != totalNative` — the fuzzer had chosen the escrow's
**own address** as `msg.sender` and pre-funded it for gas, which moves
`address(escrow).balance` with no credit. Not reachable on-chain (no
`receive`, no `selfdestruct` path); fixed with `excludeSender` for the escrow,
mocks and tokens in `setUp`.

Fork lifecycle (real Uniswap v4 PoolManager / PositionManager / Permit2):

- **Curve base fee**: mixed buys/sells → Σ fee == 75 bps of quote legs (per-trade
  rounding); `sweepFees` → `FeesSwept(protocol, 0, creator)` with protocol ==
  10%, creator == 90%, protocol + creator == pending; escrow holds exactly what
  it owes; creator claims.
- **Creator tax 5% + buyback on**: tax accrues separately and bypasses the
  split; earmark == 25% of the creator bucket; creator sweep refused
  (`InternalSwapRequiresOperator`); operator sweep → protocol == 10% of base fee,
  0 < buyback ≤ 25% of creator bucket, creator == 90% − buyback + 100% tax,
  all three sum to fee + tax; bought-back tokens locked in the vault.
- **Graduation → v4 → hook**: buy-out clamps and auto-graduates (phase Swept,
  curve fees split 10/90); `createGraduatedPool` → phase PoolCreated, position
  NFT in locker, hook registered the pool; token→ETH swap through the real
  PoolManager: hook took **exactly 75 bps** of gross output into `pendingFees`;
  `sweepPoolFees` → protocol 10% / creator 90%, conservation holds.

Run: `forge test --match-path "test/Fork*"`. Uses `ROBINHOOD_RPC_URL` from
`contracts/pons-v2/.env` if set, else Robinhood public
(`https://rpc.mainnet.chain.robinhood.com`). Never commit the `.env`.

Full suite (2026-09-13): **45/45** — 34 escrow unit/fuzz, 4 escrow invariants,
7 fork lifecycle — plus the deploy dry-run's config asserts against live state.

---
## 6. Web / backend follow-ups after deploy

Done 2026-09-13 (typecheck + `pons.py` parse clean):

- `web/src/lib/pons/chain.ts` `PONS` → our 9 addresses
- `backend/pons.py` `PONS_FACTORY` / `PONS_FEE_ESCROW` / `PONS_LAUNCH_AND_BUY` → ours
- `web/src/ui/CoinTermsFields.tsx` default `buybackEnabled: false`
- `web/src/lib/pons/launch.ts` insufficient-gas copy `0.0005` → `0.00025 ETH`
  (`INSUFFICIENT_GAS_COPY`); `trade.ts` matches on the `Launch fee is` prefix.
  All other economics (launch fee, `feeBps`, `curveFeeBps`, `maxCreatorTaxBps`,
  snipe) were already read live from the factory — nothing else hardcoded.

First launch on our factory (2026-09-13): `105-test` → `FORKTEST`
`0x46d69a080527734d8a45b89570D0eBcc0486AFbe`, curve `0xAB175BEc…A463`,
native ETH, config 0. Verified live: `feeBps = 75`, `launchFee = 0.00025`,
`quoteFeeBalance` == 75 bps of curve inflow. It launched with
`buybackEnabled = true` because the web bundle predated the default flip —
**redeploy `web/` after pulling**.

Curve stats fix (same day): `eth_getLogs` had no `fromBlock` → nodes default
to `latest..latest` → Trades 0, empty sparkline. Now bounded at the launch tx
block (`coin.tx_hash` receipt, cached). `fetchCurveActivity` derives trades,
~24h volume (block-time estimate), holders (net position from buy/sell logs)
and the sparkline from one cached log fetch; graduation shows `<0.1%` /
one decimal instead of rounding to 0. Trade ticket slippage is editable
(0.5 / 1 / 3 / 5 % or custom, warns above 5 %).

v2 swap done 2026-09-14: `chain.ts` `PONS` + `pons.py` `PONS_*` → the
`BuilderPad*` addresses above (typecheck + parse clean); `105-test` coin row
cleared (FORKTEST was v1). **Redeploy web + backend** so they stop reading v1.

Wizard coverage of the contract surface (2026-09-14): every per-launch input
is now exposed — identity from the app, symbol, quote asset, dev buy,
creator tax, buyback, fee recipient, and **team wallets**
(`snipeTaxExemptions[]`, Advanced, max 32; launcher + fee recipient are
exempted by the factory itself, so the UI dedupes them out). `launchToken`
uses the 4-arg overload only when the list is non-empty. Dev buy shows the
expected tokens (`quoteInitialBuy`, nets curve fee + tax, flags a curve
buy-out refund), `% of supply`, the wallet's **Available** quote balance and
a **Max** (native: balance − launch fee − 0.0015 ETH gas reserve). Not
exposed on purpose: `launchConfigId` (one config), dev-buy `recipient`
(always HD 0). Post-launch, `transferCreatorFeeRecipient` (current recipient
→ new wallet) has no UI yet — only `setBuybackEnabled` does.

Still open:

- My apps: **Change fee recipient** (`transferCreatorFeeRecipient`, signed by
  the current recipient) + `POST /coin/refresh`
- Re-check `PONS_QUOTE_SYMBOLS` against what we actually approve (HOOD is
  listed but not approved on either factory)
- The LWL showcase card is an `EXTERNAL_COINS` exception (`backend/tenants.py`)
  — launched on pools.xyz, not Pons — and is unaffected by the swap
- Copy that says "Pons" (docs URL `PONS_DOCS_URL`, marquee, byline) — leave
  until product decisions are made; Pons brand guidelines forbid implying
  partnership

---

## 7. Decisions (2026-09-13)

| Item | Decision |
|---|---|
| Snipe tax | Match **live factory**: `setSnipeTaxStartBps(9900)`, `setSnipeTaxSeconds(3)` |
| Buyback default | **OFF**. Rationale: with buyback on, 25% of the creator's 90% is spent buying the token and locked in the 5-year vest instead of being paid out in the quote asset. Off = creators receive their full share immediately; they can opt in per launch. Web default flips to `false`. |
| Protocol fee recipient | `0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB` (project builder wallet, `DEFAULT_BUILDER_ADDRESS`). Used for hook `protocolFeeRecipient` and vault protocol payouts. |
| Deployer / owner | Same wallet unless told otherwise (`Ownable2Step` allows a later transfer to a multisig). Fund with ETH on 4663 for gas only. |
| Pair tokens | Same set as live Pons: native ETH + the 17 below (all approved on the live factory as of 2026-09-13). |

### Pair tokens to approve (copied from live factory `pairTokenEconomics`)

Ratio `phantomQuote : graduationThreshold` is `0.4` for every asset (same as
the ETH config `1.68 : 4.2`). Values are wei / base units at the token's
decimals. Copy verbatim into the deploy constants; re-probe before deploy.

| Symbol | Address | phantomQuote | graduationThreshold | dec |
|---|---|---|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `16640000000000000000` | `41600000000000000000` | 18 |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `10400000000000000000` | `26000000000000000000` | 18 |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `9680000000000000000` | `24200000000000000000` | 18 |
| MSFT | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | `6431455767077268559` | `16078639417693171399` | 18 |
| AMZN | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | `11732116436857081003` | `29330291092142702509` | 18 |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `9680000000000000000` | `24200000000000000000` | 18 |
| META | `0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35` | `5427158043940468620` | `13567895109851171552` | 18 |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | `4360000000000000000` | `10900000000000000000` | 18 |
| COIN | `0x6330D8C3178a418788dF01a47479c0ce7CCF450b` | `20988269381362569995` | `52470673453406424989` | 18 |
| MSTR | `0xec262a75e413fAfD0dF80480274532C79D42da09` | `31992090954028668648` | `79980227385071671620` | 18 |
| AMD | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | `6666201836383609007` | `16665504590959022517` | 18 |
| NFLX | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | `52121218543046357757` | `130303046357615894393` | 18 |
| PLTR | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | `18826050105361742750` | `47065125263404356876` | 18 |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` | `147600000000000000000` | `369000000000000000000` | 18 |
| AMC | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` | `1536025873605948496516` | `3840064684014871241292` | 18 |
| SPCX | `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` | `28880000000000000000` | `72200000000000000000` | 18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `3236000000` | `8090000000` | 6 |

Note: these are USD-equivalent snapshots Pons set at approval time (USDG
threshold ≈ $8,090). HOOD is in `PONS_QUOTE_SYMBOLS` but not in the Robinhood
registry as an active on-chain asset today, so it is not approved live either.

### Cost

Gas only. No USDC, no seed liquidity, no protocol deposit. Bridge
~0.02–0.05 ETH to the deployer on 4663.

---

## 8. Post-deploy test plan (product, on the live stack)

Done so far: launch via **Launch token** (launch-later path), 2 small native
buys, card reads. Everything below is still open. Amounts can stay tiny
(≤ 0.001 ETH) except the graduation item. Tick them off in order — later
items depend on earlier state.

### A. Money paths (the ones that matter)

| # | Test | Expect |
|---|---|---|
| A1 | **Sell** on the curve ticket (partial, then Max) | `CurveSell` log; ETH back minus 75 bps; ticket balance + Trades + sparkline update; slippage respected |
| A2 | **Creator claim, buyback OFF** — call `sweepFees` on the curve from the *creator* wallet, then **Claim** in My apps | Sweep splits 10/90; escrow `balanceOf(creator)` = 90 %; claim moves ETH to HD 0; card "Earned" matches |
| A3 | **Creator claim, buyback ON** (FORKTEST is on) — creator calls `sweepFees` | **Reverts `InternalSwapRequiresOperator`**. With buyback on, only `feeSweepOperator` (= our owner wallet) may sweep. Decide the ops story now: cron from the owner key, or a "request sweep" button that pings us, or keep buyback opt-in only with a clear "we sweep weekly" note. Until swept, the creator sees fees only as `quoteFeeBalance`, not claimable |
| A4 | **Protocol fee arrives** — after any sweep, `escrow.balanceOf(0x29a1…23EB)` | = 10 % of swept fees; claim from the builder wallet works (Builder Wallet claim bar) |
| A5 | **Creator tax launch** (e.g. 5 %) + buys | `creatorTaxBalance` grows separately; on sweep, 100 % of tax → creator; UI shows tax on card + `Creator Tax` stat |
| A6 | **ERC-20 quote launch** (USDG — 6 decimals — is the nastiest) | Approve router → `launchAndBuy` with `value = launchFee` only; curve buy needs approve → `buy` with `value = 0`; decimals right in ticket, mcap, `$` conversion; sell returns USDG |
| A7 | **launchAndBuy vs launchToken** — one launch with dev buy, one without | Dev-buy launch: `CurveBuy` in the same tx, `tokensOut` == our `quoteInitialBuy`; no-dev-buy launch: `value = launchFee` exactly |

### B. Rules / guards

| # | Test | Expect |
|---|---|---|
| B1 | **Snipe tax** — buy from a *different* wallet within 3 s of launch (needs a dev-buy launch + a second wallet ready) | Quote shows the 99 % → decaying snipe tax; buy from launcher / fee recipient is exempt |
| B1b | **Team wallets** — launch with a second wallet listed under Advanced → Team wallets, then buy from it inside the window | `currentSnipeTaxBps(thatWallet) == 0`; `SnipeTaxExempted` emitted for it at launch; a wallet *not* listed still pays |
| B1c | **Dev-buy preview** — type an amount, compare `≈ tokens` with the `CurveBuy.tokensOut` in the launch receipt; try Max on a small wallet | Preview matches to the token (same math as `minTokensOut`); Max leaves fee + gas and the launch still goes through |
| B2 | **Slippage revert** — set 0.5 %, then front-run yourself from another wallet | `SlippageExceeded` copy, no funds lost |
| B3 | **`canLaunch` gate** — `factory.setLaunchEnabled(false)` from the owner, try to launch | Wizard shows the gate; Publish still creates the app; re-enable after |
| B4 | **Wrong fee / stale economics** — trigger `LaunchEconomicsMismatch` by changing `setHookFeeBps` between quote and send (owner) | UI retries once with fresh `expectedEconomics` and succeeds |
| B5 | **Backend `verify_launch`** — `POST /coin` with a token whose `deployer != owner_wallet` (e.g. FORKTEST from another user) | 400; `POST /coin` twice → 409 |
| B6 | **`setBuybackEnabled` from UI** (My apps toggle) → `POST /coin/refresh` | On-chain flag flips (fee recipient signs); DB `coin_buyback_enabled` follows; owner may only *disable* |
| B7 | **Wallet/chain**: start with the wallet on Arbitrum, launch | `switchChain(4663)` + wait; no "unknown reason" revert |
| B8 | **Insufficient ETH** — wallet with 0.0002 ETH on step 3 / Launch token later | Button muted as **Add ETH to launch** with the exact need vs. held (`useLaunchFunding`); "Publish app without token" still enabled; button unlocks ≤20 s after ETH lands. Same for an ERC-20 quote when the dev buy exceeds the token balance. No wallet popup ever opens |

### C. Graduation (the expensive one — do it once)

| # | Test | Expect |
|---|---|---|
| C1 | Push a test launch over **4.2 ETH** real reserve (≈ $10k round-trip; you get most back on sell after) | Auto-graduate → phase Swept → `createGraduatedPool` → phase PoolCreated; position NFT in `BuilderPadLaunchLocker`; curve ticket shows "Graduated"; Dexscreener/Gecko pick up the v4 pool within minutes |
| C2 | Swap on the v4 pool (Uniswap UI or `SimpleSwapRouter`) | Hook takes 75 bps into `pendingFees`; `sweepPoolFees` → 10/90; creator page reads hook `pendingFees` before the sweep |
| C3 | Card + creator page after graduation | `source: 'dex'`; 24h stats from Dexscreener; graduation bar gone; "Trade on GeckoTerminal" link |

If 4.2 ETH is too much for a test, do C1–C3 on a fork
(`test/Fork.Lifecycle.t.sol::test_graduation_and_hookFeeSplit` already covers
the contract side) and only smoke-test the **UI** against a real graduated
token later.

### D. Directory / multi-tenant

| # | Test | Expect |
|---|---|---|
| D1 | Two apps with tokens from **two different logins** | Directory, Top creators, Explore sort by mcap; each creator sees only their own claim |
| D1b | **Two live apps, one activated creator** (same builder `b`) — e.g. `test-app` + `minobi` | New app shows **0** volume/earned until it has its own desk fills; the sibling keeps the HL lifetime; after a fill on the new app both cards move and their sum ≈ the builder's lifetime (`hl_builder.share`) |
| D2 | App **without** token next to apps with tokens | No curve reads fired for it; "Launch token" CTA in My apps |
| D3 | Showcase (`a25c7e3d…`, `EXTERNAL_COINS`) | Still renders forced stats; no factory reads |
| D4 | Archive an app with a live token | Card leaves the directory; token stays tradable on-chain; creator page still resolves |

### E. Ops before real users

- Sourcify verification for all 9 + guard + one curve + one token (§4).
- `Ownable2Step` handoff plan: who holds the owner key, and when it moves to
  a multisig. Every setter (`setLaunchFee`, `setHookFeeBps`, pair tokens,
  `setLaunchEnabled`) is owner-only.
- Fee-sweep operator process (A3). This is the one that bites first.
- Alerts: watch `TokenLaunched` on the factory (so a launch that skipped
  `POST /coin` is still discoverable) and factory ETH balance ≈ 0 (fees live in
  the escrow, never the factory).
- Rename check on Blockscout token pages once Sourcify data is picked up.
