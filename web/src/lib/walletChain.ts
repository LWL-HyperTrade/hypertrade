/**
 * Put the Privy trade wallet (HD 0) on a chain and hand back a provider that
 * actually reports it.
 *
 * Privy `ConnectedWallet.switchChain` resolves, then React swaps in a new
 * `ConnectedWallet` object. A provider from the old object keeps answering
 * the old `eth_chainId`, so "switch → get provider → check" on one instance
 * fails on the first click and works on the retry. `getProvider` must read the
 * latest wallet (auth.tsx refs); we re-fetch it on every tick.
 * https://docs.privy.io/wallets/using-wallets/ethereum/switch-chain
 */
import type { Eip1193Provider } from './hlTrade';

export type ChainSwitcher = (chainId: number) => Promise<void>;
export type ProviderGetter = () => Promise<Eip1193Provider | null>;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(message)), ms);
    p.then(resolve, reject).finally(() => window.clearTimeout(t));
  });
}

function parseEvmChainId(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  return Number.parseInt(s, /^0x/i.test(s) ? 16 : 10);
}

export async function readProviderChainId(provider: Eip1193Provider): Promise<number> {
  try {
    return parseEvmChainId(await provider.request({ method: 'eth_chainId', params: [] }));
  } catch {
    return NaN;
  }
}

export async function ensureTradeWalletChain(args: {
  chainId: number;
  chainName: string;
  switchChain: ChainSwitcher;
  getProvider: ProviderGetter;
  /** Total budget for the wallet to land on the chain. */
  timeoutMs?: number;
}): Promise<Eip1193Provider> {
  const { chainId, chainName } = args;
  const first = await args.getProvider();
  if (!first) throw new Error('Wallet is not ready. Sign in again.');
  if ((await readProviderChainId(first)) === chainId) return first;

  await withTimeout(
    args.switchChain(chainId),
    20_000,
    `Could not switch the wallet to ${chainName}. Retry.`,
  );
  // Same instance nudge; harmless when the wallet already moved.
  try {
    await withTimeout(
      first.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      }),
      8_000,
      'switch',
    );
  } catch {
    /* already on chain, or this provider only flips via ConnectedWallet.switchChain */
  }

  const deadline = Date.now() + (args.timeoutMs ?? 20_000);
  let lastNudge = Date.now();
  while (Date.now() < deadline) {
    const fresh = await args.getProvider();
    if (fresh && (await readProviderChainId(fresh)) === chainId) return fresh;
    if (Date.now() - lastNudge > 3_000) {
      lastNudge = Date.now();
      try {
        await args.switchChain(chainId);
      } catch {
        /* keep polling */
      }
    }
    await new Promise((r) => window.setTimeout(r, 150));
  }
  throw new Error(`Wallet is not on ${chainName} yet. Retry.`);
}
