/** Keep in sync with backend/tenants.py RESERVED_SLUGS. */
export const RESERVED_SLUGS = new Set([
  'about',
  'admin',
  'ai-agents',
  'ai-agents-faq',
  'api',
  'app',
  'apps',
  'asset',
  'assets',
  'bank',
  'bank-faq',
  'bank-guest',
  'bank-notifications',
  'bank-statement',
  'blog',
  'builderpad',
  'cdn',
  'create',
  'deposit',
  'deposit-withdraw-history',
  'docs',
  'faq',
  'fees',
  'ftp',
  'health',
  'help',
  'home',
  'hypertrade',
  'index',
  'legal',
  'login',
  'mail',
  'me',
  'news',
  'portfolio',
  'price-alerts',
  'privacy',
  'privacy-policy',
  'profile',
  'rewards',
  'showcase',
  'static',
  'status',
  'support',
  't',
  'terms',
  'trade',
  'trade-history',
  'www',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function normalizeTenantSlug(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

export function slugError(raw: string): string | null {
  const slug = normalizeTenantSlug(raw);
  if (slug.length < 3 || slug.length > 32) {
    return 'Use 3–32 characters';
  }
  if (!SLUG_RE.test(slug)) {
    return 'Lowercase letters, numbers, and hyphens only';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'This slug is reserved';
  }
  return null;
}
