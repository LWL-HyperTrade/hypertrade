import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setTenantBuilderFeeOverride } from '../providers/BuilderConfigProvider';
import { useAuth } from '../providers/AuthContext';
import { useAppStore } from '../store/appStore';
import { fetchTenant, recordTenantOrder } from './api';
import { normalizeTenantSlug, RESERVED_SLUGS, slugError } from './reserved';
import { registerTenantOrderHooks } from './orderBridge';
import type { TenantPublic } from './types';

const STORAGE_KEY = 'builderpad_active_tenant_v1';

type TenantContextValue = {
  tenant: TenantPublic | null;
  slug: string | null;
  isLoading: boolean;
  error: string | null;
  isTenantRoute: boolean;
  activateSlug: (slug: string) => Promise<void>;
  clearTenant: () => void;
};

const TenantContext = createContext<TenantContextValue>({
  tenant: null,
  slug: null,
  isLoading: false,
  error: null,
  isTenantRoute: false,
  activateSlug: async () => {},
  clearTenant: () => {},
});

function slugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/t\/([^/]+)/);
  if (!match) return null;
  const slug = normalizeTenantSlug(decodeURIComponent(match[1] || ''));
  if (!slug || RESERVED_SLUGS.has(slug) || slugError(slug)) return null;
  return slug;
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { getAccessToken } = useAuth();
  const walletAddress = useAppStore((s) => s.user?.wallet?.address ?? null);

  const routeSlug = slugFromPath(pathname);
  const isTenantRoute = routeSlug != null;
  const isHypertradeHome = pathname === '/';

  const [tenant, setTenant] = useState<TenantPublic | null>(null);
  const [slug, setSlug] = useState<string | null>(routeSlug);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tenantRef = useRef<TenantPublic | null>(null);
  const tokenRef = useRef(getAccessToken);
  const walletRef = useRef(walletAddress);

  tenantRef.current = tenant;
  tokenRef.current = getAccessToken;
  walletRef.current = walletAddress;

  const clearTenant = useCallback(() => {
    tenantRef.current = null;
    setTenant(null);
    setSlug(null);
    setError(null);
    setTenantBuilderFeeOverride(null);
    void AsyncStorage.removeItem(STORAGE_KEY);
  }, []);

  const activateSlug = useCallback(async (nextSlug: string) => {
    const normalized = normalizeTenantSlug(nextSlug);
    if (slugError(normalized)) {
      setError('Not found');
      return;
    }
    setIsLoading(true);
    setError(null);
    setSlug(normalized);
    try {
      const data = await fetchTenant(normalized);
      tenantRef.current = data;
      setTenant(data);
      setTenantBuilderFeeOverride(data.builder_fee_tenths);
      await AsyncStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      tenantRef.current = null;
      setTenant(null);
      setTenantBuilderFeeOverride(null);
      setError('This app could not be loaded');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isHypertradeHome) {
      clearTenant();
      return;
    }
    if (routeSlug) {
      if (tenantRef.current?.slug !== routeSlug) {
        void activateSlug(routeSlug);
      }
      return;
    }
    let cancelled = false;
    (async () => {
      const stored = (await AsyncStorage.getItem(STORAGE_KEY))?.trim() || '';
      if (cancelled || !stored || slugError(stored)) return;
      if (!tenantRef.current) {
        void activateSlug(stored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeSlug, isHypertradeHome, activateSlug, clearTenant]);

  useEffect(() => {
    registerTenantOrderHooks({
      getActive: () => {
        const t = tenantRef.current;
        if (!t || t.status !== 'live' || !t.cloid_prefix) return null;
        return { tenantId: t.id, slug: t.slug, cloidPrefix: t.cloid_prefix };
      },
      report: (args) => {
        const wallet = (args.walletAddress || walletRef.current || '').toLowerCase();
        if (!wallet) return;
        void (async () => {
          const token = await tokenRef.current();
          if (!token) return;
          try {
            await recordTenantOrder(
              args.slug,
              {
                cloid: args.cloid,
                oid: args.oid ?? undefined,
                symbol: args.symbol,
                wallet_address: wallet,
              },
              token,
            );
          } catch {
            // best-effort
          }
        })();
      },
    });
    return () => registerTenantOrderHooks(null);
  }, []);

  const value = useMemo<TenantContextValue>(
    () => ({
      tenant,
      slug,
      isLoading,
      error,
      isTenantRoute,
      activateSlug,
      clearTenant,
    }),
    [tenant, slug, isLoading, error, isTenantRoute, activateSlug, clearTenant],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  return useContext(TenantContext);
}
