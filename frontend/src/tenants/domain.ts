/**
 * Public URL for a BuilderPad app:
 *   https://{slug}.builderpad.xyz
 *
 * Optional EXPO_PUBLIC_TENANT_BASE_DOMAIN (hostname only). Legacy
 * EXPO_PUBLIC_TENANT_PUBLIC_ORIGIN is still read for the hostname.
 */
function hostnameFromOrigin(raw: string | undefined): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    const host = new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const TENANT_BASE_DOMAIN = (
  process.env.EXPO_PUBLIC_TENANT_BASE_DOMAIN?.trim().replace(/^https?:\/\//, '').split('/')[0].replace(/^\./, '')
  || hostnameFromOrigin(process.env.EXPO_PUBLIC_TENANT_PUBLIC_ORIGIN)
  || 'builderpad.xyz'
).toLowerCase();

export const TENANT_PUBLIC_ORIGIN = `https://${TENANT_BASE_DOMAIN}`;

export function tenantPublicUrl(slug: string): string {
  const s = (slug || '').trim().toLowerCase();
  return `https://${s}.${TENANT_BASE_DOMAIN}`;
}
