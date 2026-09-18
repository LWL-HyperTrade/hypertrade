/** Privy HD wallets: 0 = trade (unified trading), 1 = builder (Standard, never unify).
 *  Imported MetaMask builders are not an HD index — they live on source=imported. */
export const TRADE_WALLET_INDEX = 0;
export const BUILDER_WALLET_INDEX = 1;
export const IMPORTED_BUILDER_INDEX = 0;

export type EmbeddedWalletLike = {
  address: string;
  walletClientType?: string;
  walletIndex?: number;
  chainId?: string;
  connectorType?: string;
};

type LinkedLike = {
  type?: string;
  address?: string;
  walletIndex?: number;
  wallet_index?: number;
  walletClientType?: string;
  connectorType?: string;
  chainType?: string;
  chain_type?: string;
};

function isPrivyEmbedded(w: EmbeddedWalletLike): boolean {
  return w.walletClientType === 'privy' || w.connectorType === 'embedded';
}

function isEvmAddress(addr?: string | null): addr is string {
  return !!addr && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function isSolanaish(row: {
  walletClientType?: string;
  chainId?: string;
  chainType?: string;
  chain_type?: string;
}): boolean {
  const client = (row.walletClientType || '').toLowerCase();
  const chain = `${row.chainId || ''} ${row.chainType || ''} ${row.chain_type || ''}`.toLowerCase();
  return client === 'phantom' || chain.includes('solana');
}

function indexFromLinked(accounts: LinkedLike[] | undefined, address: string): number | null {
  const want = address.toLowerCase();
  for (const acct of accounts ?? []) {
    if (!acct?.address || acct.address.toLowerCase() !== want) continue;
    const n = acct.walletIndex ?? acct.wallet_index;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

export function walletHdIndex(
  wallet: EmbeddedWalletLike,
  linkedAccounts?: LinkedLike[],
): number | null {
  if (typeof wallet.walletIndex === 'number' && Number.isFinite(wallet.walletIndex)) {
    return wallet.walletIndex;
  }
  return indexFromLinked(linkedAccounts, wallet.address);
}

function embeddedList<T extends EmbeddedWalletLike>(
  wallets: T[],
  linkedAccounts?: LinkedLike[],
): Array<{ wallet: T; index: number | null }> {
  return wallets.filter(isPrivyEmbedded).map((wallet) => ({
    wallet,
    index: walletHdIndex(wallet, linkedAccounts),
  }));
}

function sameAddr(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Trading / deposit / silent HL setup. Never returns the HD 1 builder EOA. */
export function pickTradeWallet<T extends EmbeddedWalletLike>(
  wallets: T[],
  linkedAccounts?: LinkedLike[],
): T | null {
  const list = embeddedList(wallets, linkedAccounts);
  const hd0 = list.find((row) => row.index === TRADE_WALLET_INDEX);
  if (hd0) return hd0.wallet;
  const candidates = list.filter((row) => row.index !== BUILDER_WALLET_INDEX);
  if (candidates.length === 1) return candidates[0].wallet;
  const known = candidates
    .filter((row) => row.index != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return known[0]?.wallet ?? null;
}

/** Creator builder EOA (HD 1). Never the trade wallet. */
export function pickBuilderWallet<T extends EmbeddedWalletLike>(
  wallets: T[],
  linkedAccounts?: LinkedLike[],
  tradeAddress?: string | null,
): T | null {
  const list = embeddedList(wallets, linkedAccounts);
  const trade = (tradeAddress || '').toLowerCase();
  const hd1 = list.find((row) => row.index === BUILDER_WALLET_INDEX);
  if (hd1 && !sameAddr(hd1.wallet.address, trade)) return hd1.wallet;
  if (!trade) return null;
  const other = list.filter(
    (row) => row.wallet.address.toLowerCase() !== trade && row.index !== TRADE_WALLET_INDEX,
  );
  return other.length === 1 ? other[0].wallet : null;
}

/** Linked external EVM (MetaMask / injected SIWE). Never Phantom/Solana, never HD 0.
 *  `useWallets()` also lists injected extensions that are merely connected — those are
 *  not linked and must not become the builder (email signup + OKX installed). */
export function pickImportedBuilderAddress(
  wallets: EmbeddedWalletLike[],
  linkedAccounts?: LinkedLike[],
  tradeAddress?: string | null,
): string | null {
  const trade = (tradeAddress || '').toLowerCase();
  const linkedExternal: string[] = [];
  for (const acct of linkedAccounts ?? []) {
    const type = (acct.type || '').toLowerCase();
    if (type && type !== 'wallet') continue;
    if (acct.walletClientType === 'privy' || acct.connectorType === 'embedded') continue;
    if (isSolanaish(acct)) continue;
    const addr = (acct.address || '').toLowerCase();
    if (isEvmAddress(addr) && addr !== trade) linkedExternal.push(addr);
  }
  if (linkedExternal.length === 0) return null;
  for (const wallet of wallets) {
    if (isPrivyEmbedded(wallet) || isSolanaish(wallet)) continue;
    const addr = wallet.address?.toLowerCase();
    if (addr && linkedExternal.includes(addr)) return addr;
  }
  return linkedExternal[0];
}
