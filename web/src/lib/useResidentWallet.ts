/**
 * Console-only: provision + persist the resident EOA (Privy HD 2).
 * Mirrors `useEnsureBuilderWallets` for HD 1. Requires the HD 0 / HD 1 pair
 * to exist first (`/tenants/me/wallets`). Never runs on the public app.
 * Spec: docs/RESIDENTS.md.
 */
import { useCreateWallet, usePrivy, useWallets } from '@privy-io/react-auth';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { registerResidentWallet } from './api';
import { useWebAuth } from './auth';
import { RESIDENT_WALLET_INDEX, pickResidentWallet } from './embeddedWallets';
import type { BuilderWallets } from './tenants';

function createdAddress(created: unknown): string | null {
  if (!created || typeof created !== 'object') return null;
  const addr = (created as { address?: unknown }).address;
  return typeof addr === 'string' && addr.startsWith('0x') ? addr : null;
}

function alreadyHasAdditional(err: unknown): boolean {
  const msg = String(err ?? '');
  return /already has an? embedded wallet/i.test(msg) || /wallet already exists/i.test(msg);
}

export function useResidentWallet(pair: BuilderWallets | null | undefined) {
  const { address, builderAddress, getAccessToken } = useWebAuth();
  const privy = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const qc = useQueryClient();
  const linked = (privy.user?.linkedAccounts ?? []) as Array<{
    type?: string;
    address?: string;
    walletIndex?: number;
    wallet_index?: number;
    walletClientType?: string;
    connectorType?: string;
  }>;

  const stored = (pair?.resident_wallet || '').toLowerCase() || null;
  const local = pickResidentWallet(wallets, linked, address, builderAddress)?.address ?? null;
  /** Address to use: the persisted one wins; otherwise a matching local HD 2. */
  const residentAddress = (stored ?? local)?.toLowerCase() ?? null;
  /** Persisted on the row and present in this Privy session (can sign). */
  const residentReady =
    !!stored && wallets.some((w) => w.address.toLowerCase() === stored && w.walletClientType === 'privy');

  const provision = useMutation({
    mutationFn: async (): Promise<BuilderWallets> => {
      const token = await getAccessToken();
      if (!token || !address) throw new Error('Sign in again');
      if (!pair) throw new Error('Set up your builder wallets first');
      let addr = pickResidentWallet(wallets, linked, address, builderAddress)?.address ?? null;
      if (!addr) {
        try {
          const created = await createWallet({ createAdditional: true });
          addr = createdAddress(created);
        } catch (err) {
          if (!alreadyHasAdditional(err)) throw err;
        }
        if (!addr) addr = pickResidentWallet(wallets, linked, address, builderAddress)?.address ?? null;
      }
      if (!addr) throw new Error('Could not create the resident wallet');
      const lower = addr.toLowerCase();
      if (lower === address.toLowerCase() || (builderAddress && lower === builderAddress.toLowerCase())) {
        throw new Error('Resident wallet must be a third embedded address');
      }
      return registerResidentWallet(
        { resident_wallet: addr, resident_wallet_index: RESIDENT_WALLET_INDEX },
        token,
      );
    },
    onSuccess: (row) => {
      qc.setQueriesData({ queryKey: ['builder-wallets'] }, row);
      void qc.invalidateQueries({ queryKey: ['builder-wallets'] });
    },
  });

  return { residentAddress, residentReady, provision };
}
