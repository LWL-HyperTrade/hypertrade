import React, { createContext, useContext, useEffect, useState, useMemo, ReactNode } from 'react';
import { fetchBuilderConfig, BuilderConfig } from '../lib/api';

// Pinned builder identity (used if fetch fails or API returns a mismatch).
// Keep in sync with hyperliquid.ts — HyperTrade reference builder; forks set
// EXPO_PUBLIC_HL_BUILDER_* (or edit these) to earn their own fees.
const _envFee = Number(process.env.EXPO_PUBLIC_HL_BUILDER_FEE_TENTHS_BPS);
const DEFAULT_BUILDER_FEE =
  Number.isFinite(_envFee) && _envFee > 0 ? _envFee : 30; // 3 bps — sync with backend BUILDER_FEE
const DEFAULT_BUILDER_ADDRESS =
  (process.env.EXPO_PUBLIC_HL_BUILDER_ADDRESS ?? '').trim()
  || '0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB';

/** Tenant wizard ceiling (10 bps). Address stays the pinned HyperTrade builder. */
export const TENANT_BUILDER_FEE_MAX_TENTHS = 100;

function normalizeBuilderAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Trust API for fee discounts only. Never accept a different builder address
 * than the app-pinned default/env — blocks fee-recipient hijack via poisoned
 * `/builder-config`. Fee is clamped to [0, DEFAULT_BUILDER_FEE] so the API
 * cannot raise fees above the shipped client default.
 */
function resolveTrustedBuilderConfig(config: BuilderConfig | null): {
  builderAddress: string;
  builderFeeTenthsBps: number;
  builderBaseFee: number;
  builderDiscount: number;
} {
  if (config?.address) {
    const apiAddr = normalizeBuilderAddress(config.address);
    const pinnedAddr = normalizeBuilderAddress(DEFAULT_BUILDER_ADDRESS);
    if (apiAddr !== pinnedAddr) {
      console.warn(
        '[BuilderConfigProvider] Ignoring mismatched builder address from API',
        config.address,
      );
    }
  }

  const rawFee = config?.fee;
  const feeTenths =
    typeof rawFee === 'number' && Number.isFinite(rawFee)
      ? Math.min(Math.max(0, Math.floor(rawFee)), DEFAULT_BUILDER_FEE)
      : DEFAULT_BUILDER_FEE;

  const rawBase = config?.base_fee;
  const builderBaseFee =
    typeof rawBase === 'number' && Number.isFinite(rawBase)
      ? Math.min(Math.max(0, Math.floor(rawBase)), DEFAULT_BUILDER_FEE)
      : DEFAULT_BUILDER_FEE;

  const rawDiscount = config?.discount;
  const builderDiscount =
    typeof rawDiscount === 'number' && Number.isFinite(rawDiscount)
      ? Math.max(0, Math.floor(rawDiscount))
      : 0;

  return {
    builderAddress: DEFAULT_BUILDER_ADDRESS,
    builderFeeTenthsBps: feeTenths,
    builderBaseFee,
    builderDiscount,
  };
}

interface BuilderConfigContextValue {
  builderAddress: string;
  builderFeeTenthsBps: number; // e.g. 100 = 10 bps = 0.1%
  builderFeeRate: number; // decimal, e.g. 0.001 = 0.1%
  builderBaseFee: number; // original fee before discount (tenths)
  builderDiscount: number; // discount in tenths
  isLoading: boolean;
  /** Re-fetch with (or without) a wallet to get personalized fee discount. */
  refreshForWallet: (walletAddress: string | null) => void;
}

const BuilderConfigContext = createContext<BuilderConfigContextValue>({
  builderAddress: DEFAULT_BUILDER_ADDRESS,
  builderFeeTenthsBps: DEFAULT_BUILDER_FEE,
  builderFeeRate: DEFAULT_BUILDER_FEE * 0.00001,
  builderBaseFee: DEFAULT_BUILDER_FEE,
  builderDiscount: 0,
  isLoading: true,
  refreshForWallet: () => {},
});

let _cachedBuilderFee = DEFAULT_BUILDER_FEE;
let _cachedBuilderAddress = DEFAULT_BUILDER_ADDRESS;
let _tenantFeeOverride: number | null = null;
const _tenantFeeListeners = new Set<(fee: number | null) => void>();

export function setTenantBuilderFeeOverride(feeTenthsBps: number | null) {
  if (feeTenthsBps == null || !Number.isFinite(feeTenthsBps)) {
    _tenantFeeOverride = null;
  } else {
    _tenantFeeOverride = Math.min(
      Math.max(0, Math.floor(feeTenthsBps)),
      TENANT_BUILDER_FEE_MAX_TENTHS,
    );
  }
  _tenantFeeListeners.forEach((fn) => fn(_tenantFeeOverride));
}

function subscribeTenantBuilderFee(fn: (fee: number | null) => void): () => void {
  _tenantFeeListeners.add(fn);
  return () => {
    _tenantFeeListeners.delete(fn);
  };
}

export function BuilderConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<BuilderConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [tenantFeeTenths, setTenantFeeTenths] = useState<number | null>(
    () => _tenantFeeOverride,
  );

  useEffect(() => subscribeTenantBuilderFee(setTenantFeeTenths), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await fetchBuilderConfig(walletAddr ?? undefined);
        if (!cancelled) {
          setConfig(data);
        }
      } catch (e) {
        console.warn('[BuilderConfigProvider] Failed to fetch builder config, using defaults', e);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddr]);

  const value = useMemo<BuilderConfigContextValue>(() => {
    const trusted = resolveTrustedBuilderConfig(config);
    const feeTenths =
      tenantFeeTenths != null
        ? Math.min(Math.max(0, Math.floor(tenantFeeTenths)), TENANT_BUILDER_FEE_MAX_TENTHS)
        : trusted.builderFeeTenthsBps;
    return {
      builderAddress: trusted.builderAddress,
      builderFeeTenthsBps: feeTenths,
      builderFeeRate: feeTenths * 0.00001,
      builderBaseFee: tenantFeeTenths != null ? feeTenths : trusted.builderBaseFee,
      builderDiscount: tenantFeeTenths != null ? 0 : trusted.builderDiscount,
      isLoading,
      refreshForWallet: setWalletAddr,
    };
  }, [config, isLoading, tenantFeeTenths]);

  return (
    <BuilderConfigContext.Provider value={value}>
      {children}
    </BuilderConfigContext.Provider>
  );
}

export function useBuilderConfig() {
  return useContext(BuilderConfigContext);
}

export function setGlobalBuilderConfig(address: string, feeTenthsBps: number) {
  // Belt-and-suspenders: never cache an unpinned builder address.
  const trusted = resolveTrustedBuilderConfig({
    address,
    fee: feeTenthsBps,
  });
  _cachedBuilderAddress = trusted.builderAddress;
  _cachedBuilderFee = trusted.builderFeeTenthsBps;
}

export function getGlobalBuilderFee(): number {
  if (_tenantFeeOverride != null) return _tenantFeeOverride;
  return _cachedBuilderFee;
}

export function getGlobalBuilderAddress(): string {
  return _cachedBuilderAddress;
}

// Helper to sync context to global (call inside provider)
// Also refreshes builder config with wallet address for personalized fee discount.
export function useSyncBuilderConfigToGlobal() {
  const { builderAddress, builderFeeTenthsBps, isLoading, refreshForWallet } = useBuilderConfig();
  
  useEffect(() => {
    if (!isLoading) {
      setGlobalBuilderConfig(builderAddress, builderFeeTenthsBps);
    }
  }, [builderAddress, builderFeeTenthsBps, isLoading]);

  return { refreshForWallet };
}
