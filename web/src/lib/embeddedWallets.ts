/** Privy HD wallets: 0 = trade (unified trading), 1 = builder (Standard, never unify),
 *  2 = resident (AI agents trade from it — docs/RESIDENTS.md).
 *  Imported MetaMask builders are not an HD index — they live on source=imported. */
export const TRADE_WALLET_INDEX = 0;
export const BUILDER_WALLET_INDEX = 1;
export const RESIDENT_WALLET_INDEX = 2;
export const IMPORTED_BUILDER_INDEX = 0;

export type EmbeddedWalletLike = {
  address: string;
  walletClientType?: string;
  walletIndex?: number;
  chainId?: string;
  connectorType?: string;
  /** Privy: true for wallets imported by private key (UR test signer, etc.). */
  imported?: boolean;
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
  imported?: boolean;
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

function isImportedWallet(wallet: EmbeddedWalletLike, linkedAccounts?: LinkedLike[]): boolean {
  if (wallet.imported === true) return true;
  const want = wallet.address.toLowerCase();
  for (const acct of linkedAccounts ?? []) {
    if (!acct?.address || acct.address.toLowerCase() !== want) continue;
    if (acct.imported === true) return true;
  }
  return false;
}

/** HD 0 on the Privy user — never an imported extra key (UR test signer). */
function hd0AddressFromLinked(linkedAccounts?: LinkedLike[]): string | null {
  for (const acct of linkedAccounts ?? []) {
    const type = (acct.type || '').toLowerCase();
    if (type && type !== 'wallet') continue;
    if (acct.walletClientType !== 'privy' && acct.connectorType !== 'embedded') continue;
    if (acct.imported === true) continue;
    const n = acct.walletIndex ?? acct.wallet_index;
    if (n !== TRADE_WALLET_INDEX) continue;
    if (isEvmAddress(acct.address)) return acct.address.toLowerCase();
  }
  return null;
}

/** Trading / deposit / silent HL setup. Never HD 1, never an imported test key. */
export function pickTradeWallet<T extends EmbeddedWalletLike>(
  wallets: T[],
  linkedAccounts?: LinkedLike[],
): T | null {
  const list = embeddedList(wallets, linkedAccounts).filter(
    (row) => !isImportedWallet(row.wallet, linkedAccounts),
  );
  const hd0Linked = hd0AddressFromLinked(linkedAccounts);
  if (hd0Linked) {
    const match = list.find((row) => row.wallet.address.toLowerCase() === hd0Linked);
    if (match) return match.wallet;
  }
  const hd0 = list.find((row) => row.index === TRADE_WALLET_INDEX);
  if (hd0) return hd0.wallet;
  // Account still has HD 0, but it is not in this session's wallet list yet.
  // Do not fall back to a leftover imported EOA.
  if (hd0Linked) return null;
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

/**
 * Resident EOA (HD 2 only). Never the trade wallet, never the builder,
 * never an imported key. No leftover-wallet fallback.
 */
export function pickResidentWallet<T extends EmbeddedWalletLike>(
  wallets: T[],
  linkedAccounts?: LinkedLike[],
  tradeAddress?: string | null,
  builderAddress?: string | null,
): T | null {
  const list = embeddedList(wallets, linkedAccounts).filter(
    (row) => !isImportedWallet(row.wallet, linkedAccounts),
  );
  const trade = (tradeAddress || '').toLowerCase();
  const builder = (builderAddress || '').toLowerCase();
  const hd2 = list.find((row) => row.index === RESIDENT_WALLET_INDEX);
  if (!hd2) return null;
  const addr = hd2.wallet.address.toLowerCase();
  if (addr === trade || addr === builder) return null;
  return hd2.wallet;
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
