/**
 * Console-only: persist the trade + builder pair.
 * Email/Google → Privy HD 1. MetaMask login → imported builder, HD 0 trade only.
 * Do not call this on the public app — traders only need HD 0.
 */
import { useCreateWallet, usePrivy, useWallets } from '@privy-io/react-auth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchBuilderWallets, registerBuilderWallets } from './api';
import { useWebAuth } from './auth';
import {
  BUILDER_WALLET_INDEX,
  IMPORTED_BUILDER_INDEX,
  pickBuilderWallet,
  pickImportedBuilderAddress,
} from './embeddedWallets';
import type { BuilderWallets } from './tenants';

function alreadyHasAdditional(err: unknown): boolean {
  const msg = String(err ?? '');
  return /already has an? embedded wallet/i.test(msg) || /wallet already exists/i.test(msg);
}

function createdAddress(created: unknown): string | null {
  if (!created || typeof created !== 'object') return null;
  const addr = (created as { address?: unknown }).address;
  return typeof addr === 'string' && addr.startsWith('0x') ? addr : null;
}

export class ImportedBuilderRejected extends Error {
  readonly imported = true;
  constructor(message: string) {
    super(message);
    this.name = 'ImportedBuilderRejected';
  }
}

export function isImportedBuilderRejected(err: unknown): err is ImportedBuilderRejected {
  return err instanceof ImportedBuilderRejected || (err instanceof Error && 'imported' in err);
}

export function useEnsureBuilderWallets() {
  const { authenticated, address, getAccessToken } = useWebAuth();
  const privy = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const qc = useQueryClient();
  const linked = (privy.user?.linkedAccounts ?? []) as Array<{
    type?: string;
    address?: string;
    walletIndex?: number;
    wallet_index?: number;
    walletClientType?: string;
    connectorType?: string;
    chainType?: string;
    chain_type?: string;
  }>;
  const importedCandidate = address
    ? pickImportedBuilderAddress(wallets, linked, address)
    : null;

  const createEmbeddedBuilder = async (): Promise<BuilderWallets> => {
    const token = await getAccessToken();
    if (!token || !address) throw new Error('Sign in again');
    let builderAddr = pickBuilderWallet(wallets, linked, address)?.address ?? null;
    if (!builderAddr) {
      try {
        const created = await createWallet({ createAdditional: true });
        builderAddr = createdAddress(created);
      } catch (err) {
        if (!alreadyHasAdditional(err)) throw err;
      }
      if (!builderAddr) {
        builderAddr = pickBuilderWallet(wallets, linked, address)?.address ?? null;
      }
    }
    if (!builderAddr) {
      throw new Error('Could not create the builder wallet');
    }
    if (builderAddr.toLowerCase() === address.toLowerCase()) {
      throw new Error('Builder wallet must be a second embedded address');
    }
    return registerBuilderWallets(
      {
        trade_wallet: address,
        builder_wallet: builderAddr,
        builder_wallet_index: BUILDER_WALLET_INDEX,
        source: 'embedded',
      },
      token,
    );
  };

  const query = useQuery({
    queryKey: ['builder-wallets', privy.user?.id],
    enabled: authenticated && !!address && !!privy.user?.id && walletsReady,
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    retry: (count, err) => !isImportedBuilderRejected(err) && count < 1,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token || !address) throw new Error('Sign in again');
      const existing = await fetchBuilderWallets(token);
      if (existing) return existing;

      const imported = pickImportedBuilderAddress(wallets, linked, address);
      if (imported) {
        try {
          return await registerBuilderWallets(
            {
              trade_wallet: address,
              builder_wallet: imported,
              builder_wallet_index: IMPORTED_BUILDER_INDEX,
              source: 'imported',
            },
            token,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Could not use this wallet as builder';
          // Connected-but-unlinked extensions fail ownership. Email/Google users
          // should get HD 1, not the MetaMask fallback card.
          if (/does not belong/i.test(msg)) {
            return createEmbeddedBuilder();
          }
          throw new ImportedBuilderRejected(msg);
        }
      }

      return createEmbeddedBuilder();
    },
  });

  const createNewBuilder = useMutation({
    mutationFn: createEmbeddedBuilder,
    onSuccess: (walletsRow) => {
      qc.setQueriesData({ queryKey: ['builder-wallets'] }, walletsRow);
    },
  });

  return { ...query, importedCandidate, createNewBuilder };
}
