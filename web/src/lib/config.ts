/** Vite env; empty object outside Vite (node scripts / tests). */
const ENV: Record<string, string | undefined> = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

/** Same Privy App ID as Expo / backend. */
export const PRIVY_APP_ID = (ENV.VITE_PRIVY_APP_ID ?? '').trim();

const backend = (ENV.VITE_BACKEND_URL ?? '').trim().replace(/\/$/, '');
export const API_BASE = backend ? `${backend}/api` : '/api';

function hostnameFromOrigin(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    const host = new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Apex console is `https://builderpad.xyz`. Live apps are `https://{slug}.builderpad.xyz`.
 * Optional `VITE_TENANT_BASE_DOMAIN` (or legacy `VITE_TENANT_PUBLIC_ORIGIN`) overrides.
 */
export const TENANT_BASE_DOMAIN = (
  (ENV.VITE_TENANT_BASE_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').split('/')[0].replace(/^\./, '')
  || hostnameFromOrigin(ENV.VITE_TENANT_PUBLIC_ORIGIN ?? '')
  || 'builderpad.xyz'
).toLowerCase();

export const TENANT_PUBLIC_ORIGIN = `https://${TENANT_BASE_DOMAIN}`;

export function tenantPublicUrl(slug: string): string {
  const s = (slug || '').trim().toLowerCase();
  return `https://${s}.${TENANT_BASE_DOMAIN}`;
}

/** Localhost / Vercel preview keep path tenants so you can desk without wildcard DNS. */
export function usesPathTenants(host?: string): boolean {
  const h = (host ?? (typeof window === 'undefined' ? '' : window.location.hostname)).toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1') return true;
  return h.endsWith('.localhost') || h.endsWith('.vercel.app');
}

export function tenantAppHref(slug: string): string {
  if (typeof window !== 'undefined' && usesPathTenants(window.location.hostname)) {
    return `/t/${encodeURIComponent(slug)}`;
  }
  return tenantPublicUrl(slug);
}

export function padSlugFromHost(host?: string): string | null {
  const h = (host ?? (typeof window === 'undefined' ? '' : window.location.hostname)).toLowerCase();
  const suffix = `.${TENANT_BASE_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  if (h === TENANT_BASE_DOMAIN || h === `www.${TENANT_BASE_DOMAIN}`) return null;
  const label = h.slice(0, -suffix.length);
  return label && !label.includes('.') ? label : null;
}

export function isPadTenantHost(host?: string): boolean {
  return padSlugFromHost(host) != null;
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * Path on the BuilderPad console (apex). Relative on apex / path-tenant preview;
 * absolute `https://{TENANT_BASE_DOMAIN}/…` from a creator or custom host so `/apps`
 * is not swallowed by the branded app router.
 */
export function consoleHref(path = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') return `${TENANT_PUBLIC_ORIGIN}${p}`;
  if (usesPathTenants(window.location.hostname)) return p;
  const h = window.location.hostname.toLowerCase();
  if (h === TENANT_BASE_DOMAIN || h === `www.${TENANT_BASE_DOMAIN}`) return p;
  return `${TENANT_PUBLIC_ORIGIN}${p}`;
}

export function goToTenantApp(slug: string, navigate: (to: string) => void): void {
  const href = tenantAppHref(slug);
  if (isExternalHref(href)) {
    window.location.assign(href);
    return;
  }
  navigate(href);
}

/** Expo Router asset screen — still valid; Vite `/t/{slug}` now signs with a web agent + tenant cloid. */
export function tenantAssetUrl(coin: string): string {
  return `${TENANT_PUBLIC_ORIGIN}/asset/${encodeURIComponent(coin)}`;
}

export function tenantAppDeepLink(slug: string): string {
  return `hypertrade://t/${encodeURIComponent(slug)}`;
}

export function tenantAssetDeepLink(coin: string): string {
  return `hypertrade://asset/${encodeURIComponent(coin)}`;
}

export const DEFAULT_BUILDER_ADDRESS = '0x29a1D36DaEE6B0E0Dd4873dd964677000B6e23EB';
export const TENANT_MAX_FEE_TENTHS = 100;
/** 100 tenths = 10 bps = 0.1%. Shown as percent in the UI. */
export const TENANT_DEFAULT_FEE_TENTHS = 100;
/** Matches backend MAX_CATALOG. v1 apps ship the full HyperTrade universe. */
export const TENANT_MAX_CATALOG = 200;

/** Optional. Unset → viem public Arbitrum RPC. */
export const ARBITRUM_RPC_URL = (ENV.VITE_ARBITRUM_RPC_URL ?? '').trim();

/** Optional. Unset → viem / Privy public Robinhood RPC. Must be a Robinhood endpoint. */
export const ROBINHOOD_RPC_URL = (ENV.VITE_ROBINHOOD_RPC_URL ?? '').trim();

/**
 * Optional. WalletConnect (Reown) Cloud project ID for Privy's `wallet_connect_qr`
 * entry. Unset → Privy's shared project (rate-limited, our domains unverified).
 * Same value can instead be set in the Privy Dashboard; this wins when present.
 * Allowlist builderpad.xyz, www.builderpad.xyz and *.builderpad.xyz on the project.
 */
export const WALLETCONNECT_PROJECT_ID = (ENV.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim();
