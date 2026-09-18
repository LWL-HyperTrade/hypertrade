import { createContext, useContext, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTenantByHost } from './api';
import { isPadTenantHost, padSlugFromHost, TENANT_BASE_DOMAIN, TENANT_PUBLIC_ORIGIN } from './config';

export type BrandedHostState =
  | { kind: 'platform' }
  | { kind: 'loading'; host: string }
  | { kind: 'pad'; slug: string; host: string }
  | { kind: 'custom'; slug: string; host: string }
  | { kind: 'unknown'; host: string };

const PLATFORM_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  TENANT_BASE_DOMAIN,
  `www.${TENANT_BASE_DOMAIN}`,
  'hypertrade.exchange',
  'www.hypertrade.exchange',
  'app.hypertrade.exchange',
  'ai.hypertrade.exchange',
]);

export function isPlatformHost(host: string): boolean {
  const h = (host || '').toLowerCase();
  if (!h || PLATFORM_HOSTS.has(h)) return true;
  if (h.endsWith('.vercel.app') || h.endsWith('.localhost')) return true;
  try {
    const pub = new URL(TENANT_PUBLIC_ORIGIN).hostname.toLowerCase();
    if (h === pub) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function isTenantSkin(state: BrandedHostState): state is { kind: 'pad' | 'custom'; slug: string; host: string } {
  return state.kind === 'pad' || state.kind === 'custom';
}

/** Creator chrome / routes: known tenant hosts, plus custom domains still resolving. */
export function isCreatorHost(state: BrandedHostState): boolean {
  return state.kind === 'pad' || state.kind === 'custom' || state.kind === 'loading';
}

const BrandedHostContext = createContext<BrandedHostState>({ kind: 'platform' });

export function BrandedHostProvider({ children }: { children: ReactNode }) {
  const host = typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase();
  const platform = !host || isPlatformHost(host);
  const padSlug = platform ? null : padSlugFromHost(host);
  const q = useQuery({
    queryKey: ['tenant-by-host', host],
    enabled: !platform && !padSlug,
    queryFn: () => fetchTenantByHost(host),
    retry: false,
    staleTime: 60_000,
  });
  const value: BrandedHostState = platform
    ? { kind: 'platform' }
    : padSlug
      ? { kind: 'pad', slug: padSlug, host }
      : q.isLoading
        ? { kind: 'loading', host }
        : q.data?.slug
          ? isPadTenantHost(host)
            ? { kind: 'pad', slug: q.data.slug, host }
            : { kind: 'custom', slug: q.data.slug, host }
          : { kind: 'unknown', host };
  return <BrandedHostContext.Provider value={value}>{children}</BrandedHostContext.Provider>;
}

export function useBrandedHost(): BrandedHostState {
  return useContext(BrandedHostContext);
}

export function useTenantSlug(): string {
  const { slug = '' } = useParams();
  const branded = useBrandedHost();
  if (slug) return slug;
  return isTenantSkin(branded) ? branded.slug : '';
}

export function useTenantPaths() {
  const branded = useBrandedHost();
  const on = isCreatorHost(branded);
  return {
    home: (slug: string) => (on ? '/' : `/t/${slug}`),
    trade: (slug: string, coin: string) =>
      on ? `/trade/${encodeURIComponent(coin)}` : `/t/${slug}/trade/${encodeURIComponent(coin)}`,
  };
}
