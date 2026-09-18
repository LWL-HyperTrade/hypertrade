import type { LinkedAccount } from '@privy-io/api-types';

/** Privy linked-account shape for an external (non-embedded) EVM wallet. */
export type ExternalEthereumLinkedAccount = LinkedAccount & {
  type: 'wallet';
  chain_type: 'ethereum';
  address: string;
  connector_type?: string;
  wallet_client_type?: string;
};

export type PrimaryWalletKind = 'embedded' | 'external';

export interface PrimaryEthereumWallet {
  kind: PrimaryWalletKind;
  address: string;
}

function isEthereumWalletAccount(
  account: LinkedAccount,
): account is LinkedAccount & { type: 'wallet'; chain_type: 'ethereum'; address: string } {
  return (
    account.type === 'wallet'
    && (account as { chain_type?: string }).chain_type === 'ethereum'
    && typeof (account as { address?: string }).address === 'string'
    && (account as { address: string }).address.startsWith('0x')
  );
}

/** True when the linked account is a Privy embedded EOA (`connector_type: embedded`). */
export function isEmbeddedEthereumLinkedAccount(
  account: LinkedAccount,
): account is LinkedAccount & { type: 'wallet'; chain_type: 'ethereum'; address: string } {
  if (!isEthereumWalletAccount(account)) return false;
  return (account as { connector_type?: string }).connector_type === 'embedded';
}

/** True when the linked account is an external EOA brought via SIWE / WalletConnect. */
export function isExternalEthereumLinkedAccount(
  account: LinkedAccount,
): account is ExternalEthereumLinkedAccount {
  if (!isEthereumWalletAccount(account)) return false;
  return (account as { connector_type?: string }).connector_type !== 'embedded';
}

function rawEmbeddedHdIndex(account: LinkedAccount): number | null {
  const raw = account as { wallet_index?: number; walletIndex?: number };
  const n = raw.wallet_index ?? raw.walletIndex;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function findEmbeddedEthereumLinkedAccount(
  linkedAccounts: LinkedAccount[] | undefined,
): (LinkedAccount & { type: 'wallet'; chain_type: 'ethereum'; address: string }) | null {
  if (!linkedAccounts?.length) return null;
  const embeds = linkedAccounts.filter(isEmbeddedEthereumLinkedAccount);
  if (!embeds.length) return null;
  const hd0 = embeds.find((a) => rawEmbeddedHdIndex(a) === 0);
  if (hd0) return hd0;
  const notBuilder = embeds.filter((a) => rawEmbeddedHdIndex(a) !== 1);
  if (notBuilder.length === 1) return notBuilder[0];
  return notBuilder[0] ?? null;
}

/** Session address fallback. Never returns an HD 1 builder EOA. */
export function firstNonBuilderEmbeddedWalletAddress(
  wallets: Array<{ address?: string; walletIndex?: number; wallet_index?: number }> | undefined,
): string | null {
  if (!wallets?.length) return null;
  const hd0 = wallets.find((w) => (w.walletIndex ?? w.wallet_index) === 0);
  if (hd0?.address?.startsWith('0x')) return hd0.address;
  const rest = wallets.filter((w) => (w.walletIndex ?? w.wallet_index) !== 1);
  if (rest.length === 1 && rest[0]?.address?.startsWith('0x')) return rest[0].address;
  return null;
}

export function findExternalEthereumLinkedAccount(
  linkedAccounts: LinkedAccount[] | undefined,
): ExternalEthereumLinkedAccount | null {
  if (!linkedAccounts?.length) return null;
  return linkedAccounts.find(isExternalEthereumLinkedAccount) ?? null;
}

/**
 * Whether this Privy user authenticated with an external wallet only (no embedded EOA).
 * Used to skip auto-creating an embedded wallet on login — see Privy dashboard:
 * "Create embedded wallets for all users…" should stay OFF for wallet logins.
 */
export function userHasExternalWalletOnlyLogin(
  linkedAccounts: LinkedAccount[] | undefined,
): boolean {
  if (!linkedAccounts?.length) return false;
  const hasEmbedded = linkedAccounts.some(isEmbeddedEthereumLinkedAccount);
  if (hasEmbedded) return false;
  return linkedAccounts.some(isExternalEthereumLinkedAccount);
}

/**
 * Resolve the trading wallet for the session.
 *
 * Email/social users: embedded EOA HD index 0 (trade). HD 1 is the BuilderPad
 * builder wallet and must not become the session address.
 * Wallet-login users: external linked account when no embedded wallet exists.
 */
export function resolvePrimaryEthereumWallet(args: {
  embeddedAddress: string | null | undefined;
  linkedAccounts: LinkedAccount[] | undefined;
}): PrimaryEthereumWallet | null {
  const embedded = args.embeddedAddress?.trim();
  if (embedded && embedded.startsWith('0x')) {
    return { kind: 'embedded', address: embedded };
  }
  const external = findExternalEthereumLinkedAccount(args.linkedAccounts);
  if (external?.address) {
    return { kind: 'external', address: external.address };
  }
  return null;
}
