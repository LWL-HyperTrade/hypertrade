import { API_BASE } from './config';
import type {
  AssetRow,
  BuilderWallets,
  CreateTenantBody,
  PatchTenantBody,
  PonsQuote,
  TenantAttributionSummary,
  TenantPublic,
} from './tenants';

function unwrapError(payload: unknown, fallback: string): string {
  const detail = (payload as { detail?: unknown })?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail[0] && typeof detail[0] === 'object') {
    const row = detail[0] as { msg?: string; ctx?: { error?: string } };
    const ctx = typeof row.ctx?.error === 'string' ? row.ctx.error.trim() : '';
    if (ctx) return ctx;
    const msg = (row.msg ?? '').replace(/^Value error,?\s*/i, '').trim();
    if (msg) return msg;
  }
  return fallback;
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(unwrapError(data, res.statusText || 'Request failed'));
  return data as T;
}

export async function fetchHealth(): Promise<{ status?: string }> {
  return request('/health');
}

export async function fetchBuilderConfig(): Promise<{ address: string; fee: number }> {
  return request('/builder-config');
}

export async function fetchCatalogAssets(): Promise<AssetRow[]> {
  const [hip3, crypto] = await Promise.all([
    request<{ assets: AssetRow[] }>('/assets'),
    request<{ assets: AssetRow[] }>('/crypto-assets'),
  ]);
  const seen = new Set<string>();
  const out: AssetRow[] = [];
  // Include spot-only markets (GOLDSPOT, KNTQ, …) so the Spot picker tab can list them.
  for (const a of [...(hip3.assets ?? []), ...(crypto.assets ?? [])]) {
    const key = `${a.isSpotOnly ? 'spot:' : 'perp:'}${a.coin.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export async function fetchTenant(slug: string, token?: string | null): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(`/tenants/${encodeURIComponent(slug)}`, {
    token,
  });
  return data.tenant;
}

export type TenantStreamStatus = {
  enabled: boolean;
  platform: 'twitch';
  channel: string;
  live: boolean | null;
  title?: string;
  viewer_count?: number;
};

export async function fetchTenantStream(slug: string): Promise<TenantStreamStatus> {
  return request(`/tenants/${encodeURIComponent(slug)}/stream`);
}

export async function fetchTenantByHost(host: string): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(
    `/tenants/by-host?host=${encodeURIComponent(host)}`,
  );
  return data.tenant;
}

export async function assignTenantDomain(
  slug: string,
  host: string,
  token: string,
): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(
    `/tenants/${encodeURIComponent(slug)}/domain`,
    { method: 'POST', token, body: JSON.stringify({ host }) },
  );
  return data.tenant;
}

export async function verifyTenantDomain(slug: string, token: string): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(
    `/tenants/${encodeURIComponent(slug)}/domain/verify`,
    { method: 'POST', token },
  );
  return data.tenant;
}

export async function removeTenantDomain(slug: string, token: string): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(
    `/tenants/${encodeURIComponent(slug)}/domain`,
    { method: 'DELETE', token },
  );
  return data.tenant;
}

export async function fetchBuilderWallets(token: string): Promise<BuilderWallets | null> {
  const data = await request<{ wallets: BuilderWallets | null }>('/tenants/me/wallets', { token });
  return data.wallets ?? null;
}

export async function syncBuilderWallets(token: string): Promise<BuilderWallets> {
  const data = await request<{ wallets: BuilderWallets }>('/tenants/me/wallets/sync', {
    method: 'POST',
    token,
  });
  return data.wallets;
}

export async function setBuilderLiveMode(
  live: 'own' | 'preview',
  token: string,
): Promise<BuilderWallets> {
  const data = await request<{ wallets: BuilderWallets }>('/tenants/me/wallets/live', {
    method: 'POST',
    token,
    body: JSON.stringify({ live }),
  });
  return data.wallets;
}

export type UsdcPermitBody = {
  usd: string;
  deadline: number;
  signature: string;
  signed_nonce?: number;
};

/** One Activate: fee permit (spender = relayer) then Bridge2 deposit. Omit what already landed. */
export async function activateBuilderWallets(
  body: { fee?: UsdcPermitBody | null; deposit?: UsdcPermitBody | null },
  token: string,
): Promise<BuilderWallets> {
  const data = await request<{ wallets: BuilderWallets }>('/tenants/me/wallets/activate', {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
  return data.wallets;
}

export async function fetchRelayerAddress(user: string): Promise<string> {
  const data = await request<{ relayer: string }>(
    `/wallet/relayer-address?user=${encodeURIComponent(user)}`,
  );
  if (!data.relayer) throw new Error('Relayer is not configured');
  return data.relayer;
}

export async function registerBuilderWallets(
  body: {
    trade_wallet: string;
    builder_wallet: string;
    builder_wallet_index?: number;
    source?: 'embedded' | 'imported';
  },
  token: string,
): Promise<BuilderWallets> {
  const data = await request<{ wallets: BuilderWallets }>('/tenants/me/wallets', {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
  return data.wallets;
}

export async function listMyTenants(token: string): Promise<TenantPublic[]> {
  const data = await request<{ tenants: TenantPublic[] }>('/tenants', { token });
  return data.tenants ?? [];
}

/** Public launchpad feed — live apps + desk attribution + HL builder lifetime. */
export async function listTenantDirectory(limit = 60): Promise<TenantPublic[]> {
  const data = await request<{ tenants: TenantPublic[] }>(
    `/tenants/directory?limit=${encodeURIComponent(String(limit))}`,
  );
  return data.tenants ?? [];
}

export async function uploadTenantLogo(imageBase64: string, token: string): Promise<string> {
  const data = await request<{ logo_url: string }>('/tenants/me/logo', {
    method: 'POST',
    token,
    body: JSON.stringify({ image_base64: imageBase64 }),
  });
  if (!data.logo_url) throw new Error('Upload did not return a logo URL');
  return data.logo_url;
}

/** ETH + Robinhood stock tokens the Pons factory approves right now. */
export async function fetchPonsQuotes(): Promise<PonsQuote[]> {
  const data = await request<{ quotes: PonsQuote[] }>('/tenants/pons/quotes');
  return data.quotes ?? [];
}

/** Attach a confirmed Pons launch to the app. Backend re-reads the factory record. */
export async function recordTenantCoin(
  slug: string,
  body: {
    token: string;
    tx_hash: string;
    chain_id: number;
    launch_config_id: number;
    symbol: string;
    dev_buy_quote: string;
    /** HD 0 that signed the launch — lets the backend repair a row saved without a wallet. */
    owner_wallet?: string;
  },
  token: string,
): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(`/tenants/${encodeURIComponent(slug)}/coin`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
  return data.tenant;
}

/** Re-read Pons factory into the row (buyback switch, fee recipient). */
export async function refreshTenantCoin(slug: string, token: string): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(
    `/tenants/${encodeURIComponent(slug)}/coin/refresh`,
    { method: 'POST', token },
  );
  return data.tenant;
}

export async function createTenant(body: CreateTenantBody, token: string): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>('/tenants', {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
  return data.tenant;
}

export async function patchTenant(
  slug: string,
  body: PatchTenantBody,
  token: string,
): Promise<TenantPublic> {
  const data = await request<{ tenant: TenantPublic }>(`/tenants/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    token,
    body: JSON.stringify(body),
  });
  return data.tenant;
}

export async function deleteTenantDraft(slug: string, token: string): Promise<void> {
  await request(`/tenants/${encodeURIComponent(slug)}`, { method: 'DELETE', token });
}

/** Same body as `frontend/src/tenants/api.ts` `recordTenantOrder`. */
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
  token: string,
): Promise<void> {
  await request(`/tenants/${encodeURIComponent(slug)}/orders`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
}

export async function settleTenantOrders(
  slug: string,
  token: string,
): Promise<{ ok: boolean; updated: number }> {
  return request(`/tenants/${encodeURIComponent(slug)}/orders/settle`, {
    method: 'POST',
    token,
  });
}

export async function listTenantOrders(
  slug: string,
  token: string,
  settle = false,
): Promise<{ orders: unknown[]; summary: TenantAttributionSummary }> {
  const q = settle ? '?settle=true' : '';
  return request(`/tenants/${encodeURIComponent(slug)}/orders${q}`, { token });
}

/** Same body as `frontend/src/lib/api.ts` `depositWithPermit`. */
export async function depositWithPermit(
  body: { user: string; usd: string; deadline: number; signature: string },
  token: string,
): Promise<{ ok: boolean; txHash: string }> {
  return request('/bridge2/deposit-with-permit', {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
}

/** Gasless Arbitrum USDC send to an external wallet (relayer pays gas). */
export async function transferWithPermit(
  body: {
    user: string;
    destination: string;
    usd: string;
    deadline: number;
    signature: string;
    intent_signature: string;
    signed_nonce?: number;
  },
  token: string,
): Promise<{ ok: boolean; txHash: string }> {
  return request('/wallet/transfer-with-permit', {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
}

export type WalletTransferLimit = {
  max: number;
  used: number;
  remaining: number;
  resetInSeconds: number | null;
  windowHours: number;
};

export async function fetchTransferLimit(
  walletAddress: string,
  token: string,
): Promise<WalletTransferLimit> {
  return request(
    `/wallet/transfer-limit?wallet_address=${encodeURIComponent(walletAddress)}`,
    { token },
  );
}
