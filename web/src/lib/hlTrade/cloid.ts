/**
 * Same layout as `frontend/src/tenants/cloid.ts`.
 * 0x4250 ("BP") + sha256(tenant id)[0:8] from the server prefix + 20 random hex.
 */
export const TENANT_CLOID_TAG = '0x4250';

export function makeTenantCloid(prefix: string): string {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p.startsWith(TENANT_CLOID_TAG) || p.length < 14) {
    throw new Error('Invalid tenant cloid prefix');
  }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const cloid = `${p}${hex}`.slice(0, 34);
  if (!/^0x[0-9a-f]{32}$/.test(cloid)) {
    throw new Error('Failed to build tenant cloid');
  }
  return cloid;
}

export function extractHlOid(result: unknown): number | null {
  const statuses = (result as { response?: { data?: { statuses?: unknown[] } } })
    ?.response?.data?.statuses;
  if (!Array.isArray(statuses) || !statuses[0] || typeof statuses[0] !== 'object') {
    return null;
  }
  const first = statuses[0] as {
    oid?: number;
    resting?: { oid?: number };
    filled?: { oid?: number };
  };
  const oid = first.resting?.oid ?? first.filled?.oid ?? first.oid;
  const n = Number(oid);
  return Number.isFinite(n) ? n : null;
}

export function getPerpOrderAcceptanceError(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return 'Order was not accepted by Hyperliquid.';
  }
  const row = result as { status?: string; response?: { data?: { statuses?: unknown[] } }; error?: unknown };
  if (row.status === 'err') {
    return String(row.response ?? row.error ?? 'Order was rejected by Hyperliquid.');
  }
  const statuses = row.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return 'Hyperliquid did not return an accepted order status.';
  }
  for (const s of statuses) {
    // Position TP/SL often returns the bare string "waitingForTrigger"
    // (not `{ waitingForTrigger: … }`). See workers/ai-agent adapter + docs.
    if (typeof s === 'string') {
      const lower = s.toLowerCase();
      if (lower.includes('error') || lower.includes('reject')) {
        return s;
      }
      // waitingForTrigger / similar acceptance strings
      continue;
    }
    if (s && typeof s === 'object' && 'error' in s) {
      return String((s as { error?: unknown }).error || 'Order was rejected by Hyperliquid.');
    }
  }
  const first = statuses[0];
  if (typeof first === 'string') return null;
  if (!first || typeof first !== 'object') {
    return 'Hyperliquid returned an invalid order status.';
  }
  if ('filled' in first || 'resting' in first) return null;
  if ('waitingForTrigger' in first) return null;
  return `Hyperliquid returned an unknown order status: ${JSON.stringify(first)}`;
}
