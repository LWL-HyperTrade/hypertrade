/**
 * PONS v2 ONLY (ABI / lifecycle).
 * BuilderPad public docs (our economics + addresses): `/docs` in this app.
 * Upstream protocol reference: https://docs.ponsfamily.com/v2
 * Do NOT follow https://docs.ponsfamily.com/ — that is v1 (Uniswap v3,
 * WETH-only, no bonding curve, different factory). Mixing those ABIs reads
 * the wrong stack and reports zero / reverts.
 *
 * Chain: viem `robinhood` (id 4663). Addresses from v2 → Contracts →
 * "Deployed addresses". Per-launch curve / token: resolve from the factory.
 */
import { addRpcUrlOverrideToChain } from '@privy-io/chains';
import { createPublicClient, http, zeroAddress, type Address } from 'viem';
import { robinhood as robinhoodBase } from 'viem/chains';
import { ROBINHOOD_RPC_URL } from '../config';

/** Alchemy when set; otherwise viem's public Robinhood URL. Always override Privy's wallet RPC. */
const ROBINHOOD_HTTP = ROBINHOOD_RPC_URL || robinhoodBase.rpcUrls.default.http[0];

/**
 * Same chain object for reads, wallet writes, and Privy `supportedChains`.
 * `privyWalletOverride` is what embedded-wallet sends use. Without it Privy
 * estimates `sendTransaction` on `defaultChain` (Arbitrum) — empty code at
 * the Pons factory address → "Execution reverted for an unknown reason".
 */
export const robinhood = addRpcUrlOverrideToChain(robinhoodBase, ROBINHOOD_HTTP) as typeof robinhoodBase;
export const ROBINHOOD_CHAIN_ID = robinhood.id; // 4663

/** Canonical Pons docs. Never the unversioned site (v1). */
export const PONS_DOCS_URL = 'https://docs.ponsfamily.com/v2' as const;

/**
 * BuilderPad's own Pons v2 fork on Robinhood Chain — `BuilderPad*` contracts,
 * stack v2 deployed 2026-09-14. Same ABI as official Pons v2; economics differ
 * (75 bps, 10/90, 0.00025 ETH launch fee). Source + deploy record:
 * `contracts/pons-v2/`, `contracts/pons-v2/deployments/4663.json`,
 * `docs/PONS_FORK.md` §4. Must match `backend/pons.py`.
 *
 * Not this stack: official Pons v2 factory `0x7eD598Bc…`, Pons v1 factory
 * `0xA5aAb3F0…`, and our superseded v1 stack (factory `0x1ef3bAD2…`,
 * `deployments/4663.v1-ponsv2-names.json`). Tokens launched on any of those do
 * not exist here.
 */
export const PONS = {
  factory: '0x519580283eAEabF01d5Db061862d180c4596e709' as Address,
  memeHook: '0x4d491Fc6F68ca152AEe5ab2A39e5f3Ac9fa1E044' as Address,
  feeEscrow: '0x2F97d17Aba64bA843EFccAd5479ff8d35Be097d2' as Address,
  buybackVault: '0x095f3F9AD577E5d7564e2527717deBBbAAf5F303' as Address,
  launchLocker: '0xCf303d2B2Cc71d70Aa3795549FD6499Dfb6005f0' as Address,
  launchAndBuy: '0x9824953E1b8aA71Da182356776f54949eb8774CC' as Address,
  launchDeployer: '0xa7e1B5f729d8E15fCF64a3C7aA6fD17794E2c2cf' as Address,
  graduationExecutor: '0x17F09C3187583276826Ba138F151D268EB88F547' as Address,
  graduationGuard: '0xEA131a64B550136F43870b3134640bFed2d0305e' as Address,
} as const;

/** Native ETH launch = zero address as `pairToken` (docs → Choosing a quote asset). */
export const NATIVE_QUOTE = zeroAddress;

export function isNativeQuote(pairToken: string): boolean {
  return pairToken.toLowerCase() === NATIVE_QUOTE;
}

let cached: ReturnType<typeof createPublicClient> | null = null;
export function getRobinhoodPublicClient() {
  if (!cached) {
    cached = createPublicClient({
      chain: robinhood,
      transport: http(ROBINHOOD_HTTP, { timeout: 20_000, retryCount: 1 }),
    });
  }
  return cached;
}

const EXPLORER = robinhood.blockExplorers.default.url;
export function robinhoodTxUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}
export function robinhoodTokenUrl(address: string): string {
  return `${EXPLORER}/token/${address}`;
}
export function robinhoodAddressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

/** Launch phase per docs → Reading state → Phases. */
export const PONS_PHASES = ['curve', 'swept', 'pool', 'rescued'] as const;
export type PonsPhase = (typeof PONS_PHASES)[number];
export function phaseLabel(phase: number): PonsPhase {
  return PONS_PHASES[phase] ?? 'curve';
}
