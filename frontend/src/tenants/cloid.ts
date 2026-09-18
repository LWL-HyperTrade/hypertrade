/**
 * Tenant order cloids.
 *
 * Layout (32 hex after 0x):
 *   4250              "BP" tag — must not collide with AI 0x48544149 (HTAI)
 *   + sha256(id)[0:8] from the server-issued prefix
 *   + 20 random hex
 *
 * HL cloids are unique **per user**, not globally. Another wallet can reuse
 * the same hex. Attribute volume as (wallet, cloid) or (wallet, oid) from
 * orders this client placed — never by prefix alone.
 */
import * as Crypto from 'expo-crypto';

export const TENANT_CLOID_TAG = '0x4250';

export function isTenantCloid(cloid: unknown): boolean {
  const s = String(cloid ?? '').toLowerCase();
  return s.startsWith(TENANT_CLOID_TAG) && !s.startsWith('0x48544149');
}

export async function makeTenantCloid(prefix: string): Promise<string> {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p.startsWith(TENANT_CLOID_TAG) || p.length < 14) {
    throw new Error('Invalid tenant cloid prefix');
  }
  const rand = await Crypto.getRandomBytesAsync(10);
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  const cloid = `${p}${hex}`.slice(0, 34);
  if (!/^0x[0-9a-f]{32}$/.test(cloid)) {
    throw new Error('Failed to build tenant cloid');
  }
  return cloid;
}
