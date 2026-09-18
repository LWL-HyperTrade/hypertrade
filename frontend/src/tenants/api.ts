import { api, withAuth } from '../lib/api';
import type { BuilderWallets, CreateTenantBody, TenantAttributionSummary, TenantPublic } from './types';

function unwrapError(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data;
  const detail = data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg);
  return fallback;
}

export async function fetchTenant(slug: string): Promise<TenantPublic> {
  const res = await api.get(`/tenants/${encodeURIComponent(slug)}`);
  return res.data.tenant;
}

export async function fetchBuilderWallets(accessToken: string): Promise<BuilderWallets | null> {
  const res = await api.get('/tenants/me/wallets', withAuth(accessToken));
  return res.data.wallets ?? null;
}

export async function syncBuilderWallets(accessToken: string): Promise<BuilderWallets> {
  const res = await api.post('/tenants/me/wallets/sync', {}, withAuth(accessToken));
  return res.data.wallets;
}

export async function setBuilderLiveMode(
  live: 'own' | 'preview',
  accessToken: string,
): Promise<BuilderWallets> {
  const res = await api.post('/tenants/me/wallets/live', { live }, withAuth(accessToken));
  return res.data.wallets;
}

export async function registerBuilderWallets(
  body: {
    trade_wallet: string;
    builder_wallet: string;
    builder_wallet_index?: number;
    source?: 'embedded' | 'imported';
  },
  accessToken: string,
): Promise<BuilderWallets> {
  const res = await api.post('/tenants/me/wallets', body, withAuth(accessToken));
  return res.data.wallets;
}

export async function listMyTenants(accessToken: string): Promise<TenantPublic[]> {
  const res = await api.get('/tenants', withAuth(accessToken));
  return res.data.tenants ?? [];
}

export async function createTenant(
  body: CreateTenantBody,
  accessToken: string,
): Promise<TenantPublic> {
  try {
    const res = await api.post('/tenants', body, withAuth(accessToken));
    return res.data.tenant;
  } catch (err) {
    throw new Error(unwrapError(err, 'Could not create app'));
  }
}

export async function patchTenant(
  slug: string,
  body: Partial<CreateTenantBody> & { status?: 'live' | 'archived' },
  accessToken: string,
): Promise<TenantPublic> {
  try {
    const res = await api.patch(`/tenants/${encodeURIComponent(slug)}`, body, withAuth(accessToken));
    return res.data.tenant;
  } catch (err) {
    throw new Error(unwrapError(err, 'Could not update app'));
  }
}

export async function recordTenantOrder(
  slug: string,
  body: {
    cloid: string;
    oid?: number | null;
    symbol: string;
    wallet_address: string;
    notional_usd?: number | null;
    side?: 'buy' | 'sell';
    reduce_only?: boolean;
  },
  accessToken: string,
): Promise<void> {
  await api.post(`/tenants/${encodeURIComponent(slug)}/orders`, body, withAuth(accessToken));
}

export async function settleTenantOrders(
  slug: string,
  accessToken: string,
): Promise<{ ok: boolean; updated: number }> {
  const res = await api.post(
    `/tenants/${encodeURIComponent(slug)}/orders/settle`,
    {},
    withAuth(accessToken),
  );
  return res.data;
}

export async function listTenantOrders(
  slug: string,
  accessToken: string,
  settle = false,
): Promise<{ orders: unknown[]; summary: TenantAttributionSummary }> {
  const res = await api.get(`/tenants/${encodeURIComponent(slug)}/orders`, {
    ...withAuth(accessToken),
    params: settle ? { settle: true } : undefined,
  });
  return res.data;
}
