import { makeTenantCloid } from './cloid';

export type TenantOrderTag = {
  tenantId: string;
  slug: string;
  cloid: string;
};

export type TenantOrderReport = TenantOrderTag & {
  oid: number | null;
  symbol: string;
  walletAddress?: string | null;
};

type TenantOrderHooks = {
  getActive: () => { tenantId: string; slug: string; cloidPrefix: string } | null;
  report: (args: TenantOrderReport) => void;
};

let hooks: TenantOrderHooks | null = null;

export function registerTenantOrderHooks(next: TenantOrderHooks | null): void {
  hooks = next;
}

export async function nextTenantOrderTag(): Promise<TenantOrderTag | null> {
  const active = hooks?.getActive();
  if (!active?.cloidPrefix) return null;
  try {
    const cloid = await makeTenantCloid(active.cloidPrefix);
    return { tenantId: active.tenantId, slug: active.slug, cloid };
  } catch {
    return null;
  }
}

export function reportTenantOrder(args: TenantOrderReport): void {
  try {
    hooks?.report(args);
  } catch {
    // attribution is best-effort — never fail the HL order
  }
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
