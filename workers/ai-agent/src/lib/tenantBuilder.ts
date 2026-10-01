/**
 * BuilderPad Residents — per-agent builder code + fee attribution.
 * Spec: docs/RESIDENTS.md.
 *
 * A resident agent lives on a BuilderPad app (`tenant_residents`). Its orders
 * must carry THAT app's builder (`tenants.builder_address`, tenths-bps fee)
 * instead of the house `HL_BUILDER_ADDRESS`, and every accepted order is
 * written to `tenant_order_attributions` so the backend can settle
 * `userFills.builderFee` on `(wallet, oid)` exactly like desk orders.
 *
 * Loaded once per cycle (`refreshResidentTenants`), read per agent
 * (`builderFor`). Agents without a live tenant keep the house builder.
 * Preview apps store the platform builder in `tenants.builder_address`.
 * An own builder without ≥100 USDC perp (or on a unified account) cannot be
 * approved, so those residents credit the house builder instead.
 * A funded builder the resident wallet has never approved is the same: the
 * trader did not opt into that builder, so orders credit the house builder.
 */
import type { Hex } from 'viem';
import { config, isTestnet } from '../config.js';
import { getSupabase } from './supabase.js';

export interface BuilderCode {
  b: Hex;
  /** Tenths of a basis point (30 = 3 bps). */
  f: number;
}

export interface ResidentTenant {
  tenantId: string;
  slug: string;
  builder: BuilderCode;
}

const HOUSE_BUILDER: BuilderCode = {
  b: config.builderAddress as Hex,
  f: config.builderFeeTenthsBps,
};

let byAgent: Map<string, ResidentTenant> = new Map();

function isAddress(v: unknown): v is Hex {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

const BUILDER_MIN_PERP_USD = 100;

/** HL rejects approveBuilderFee unless the builder holds ≥100 USDC perp and is not unified. */
async function builderCanCollect(addr: string): Promise<boolean> {
  if (addr.toLowerCase() === HOUSE_BUILDER.b.toLowerCase()) return true;
  const url = isTestnet() ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
  const post = (body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const [state, absRaw] = await Promise.all([
    post({ type: 'clearinghouseState', user: addr }),
    post({ type: 'userAbstraction', user: addr }).catch(() => null),
  ]);
  const equity = Number((state as { marginSummary?: { accountValue?: string } })?.marginSummary?.accountValue ?? 0) || 0;
  const abstraction =
    typeof absRaw === 'string'
      ? absRaw
      : absRaw && typeof absRaw === 'object' && 'abstraction' in absRaw
        ? String((absRaw as { abstraction?: unknown }).abstraction ?? '')
        : '';
  if (abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin') return false;
  return equity + 1e-9 >= BUILDER_MIN_PERP_USD;
}

/** True when `user` has already approved `builder` for at least `need` tenths. */
async function userApprovedBuilder(user: string, builder: string, need: number): Promise<boolean> {
  const url = isTestnet() ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
  const raw = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'maxBuilderFee', user, builder }),
  }).then((r) => r.json());
  const approved = Number(raw);
  return Number.isFinite(approved) && approved > 0 && approved + 1e-9 >= need;
}

/**
 * Refresh the agent → live tenant map. Missing table (migration not applied)
 * or a transient read error leaves the previous map in place and logs once.
 */
export async function refreshResidentTenants(): Promise<number> {
  const supabase = getSupabase();
  const links = await supabase.from('tenant_residents').select('tenant_id, agent_id');
  if (links.error) {
    console.warn(`[residents] tenant_residents read failed: ${links.error.message}`);
    return byAgent.size;
  }
  const rows = (links.data ?? []) as Array<{ tenant_id: string; agent_id: string }>;
  if (!rows.length) {
    byAgent = new Map();
    return 0;
  }
  const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
  const agentIds = [...new Set(rows.map((r) => r.agent_id))];
  const masters = await supabase.from('ai_agents').select('id, hl_master_address').in('id', agentIds);
  const masterByAgent = new Map<string, string>();
  if (!masters.error) {
    for (const row of (masters.data ?? []) as Array<{ id?: string; hl_master_address?: string }>) {
      const id = String(row.id ?? '').toLowerCase();
      const wallet = String(row.hl_master_address ?? '').trim().toLowerCase();
      if (id && isAddress(wallet)) masterByAgent.set(id, wallet);
    }
  }
  const tenants = await supabase
    .from('tenants')
    .select('id, slug, status, builder_address, builder_fee_tenths')
    .in('id', tenantIds)
    .eq('status', 'live');
  if (tenants.error) {
    console.warn(`[residents] tenants read failed: ${tenants.error.message}`);
    return byAgent.size;
  }
  const liveById = new Map<string, ResidentTenant>();
  for (const t of (tenants.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(t.id ?? '');
    const addr = t.builder_address;
    if (!id || !isAddress(addr)) continue;
    const feeRaw = Number(t.builder_fee_tenths);
    const f = Number.isFinite(feeRaw) && feeRaw >= 0 ? Math.floor(feeRaw) : HOUSE_BUILDER.f;
    liveById.set(id, {
      tenantId: id,
      slug: String(t.slug ?? ''),
      builder: { b: addr.toLowerCase() as Hex, f },
    });
  }
  const next = new Map<string, ResidentTenant>();
  for (const r of rows) {
    const t = liveById.get(r.tenant_id);
    if (!t) continue;
    let b = t.builder.b;
    const wallet = masterByAgent.get(String(r.agent_id).toLowerCase()) ?? '';
    try {
      if (!(await builderCanCollect(b))) b = HOUSE_BUILDER.b;
      else if (wallet && b.toLowerCase() !== HOUSE_BUILDER.b.toLowerCase()) {
        const approved = await userApprovedBuilder(wallet, b, t.builder.f);
        if (!approved) b = HOUSE_BUILDER.b;
      }
    } catch (err) {
      console.warn(`[residents] builder check failed for ${t.slug}: ${err}`);
      b = HOUSE_BUILDER.b;
    }
    next.set(String(r.agent_id).toLowerCase(), {
      ...t,
      builder: { b, f: t.builder.f },
    });
  }
  byAgent = next;
  return next.size;
}

/** Live tenant this agent lives on, if any. */
export function residentTenantFor(agentId: string): ResidentTenant | null {
  return byAgent.get(agentId.toLowerCase()) ?? null;
}

/** Builder code to attach to this agent's orders. */
export function builderFor(agentId: string): BuilderCode {
  return residentTenantFor(agentId)?.builder ?? HOUSE_BUILDER;
}

export interface AttributionInput {
  tenant: ResidentTenant;
  privyUserId: string;
  /** Account whose fills carry the fee — the resident wallet (HD 2). */
  walletAddress: Hex;
  cloid: Hex | null | undefined;
  oid: number | null;
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number | null;
  reduceOnly: boolean;
}

/**
 * Mirror of `POST /api/tenants/{slug}/orders`. Best-effort: attribution must
 * never fail an order that HL already accepted. Duplicate `(wallet, cloid)` is
 * a no-op (unique constraint) — an IOC retry with the same cloid lands once.
 */
export async function recordTenantOrder(input: AttributionInput): Promise<void> {
  if (!input.cloid && input.oid == null) return;
  const tenths = input.tenant.builder.f;
  const notional = input.notionalUsd != null && Number.isFinite(input.notionalUsd)
    ? Math.max(0, input.notionalUsd)
    : null;
  const row = {
    tenant_id: input.tenant.tenantId,
    privy_user_id: input.privyUserId,
    wallet_address: input.walletAddress.toLowerCase(),
    // Unique key is (wallet, cloid); fall back to a synthetic per-oid tag when
    // HL gave us an oid but the order had no cloid (never for our opens).
    cloid: (input.cloid ?? `oid:${input.oid}`).toLowerCase(),
    oid: input.oid,
    symbol: input.symbol.slice(0, 40),
    builder_address: input.tenant.builder.b,
    notional_usd: notional,
    builder_fee_tenths: tenths,
    est_builder_fee_usd: notional != null ? Math.round((notional * tenths) / 100_000 * 1e8) / 1e8 : null,
    side: input.side,
    reduce_only: input.reduceOnly,
  };
  const { error } = await getSupabase().from('tenant_order_attributions').insert(row);
  if (error) {
    // 23505 = unique_violation → already recorded.
    if (String(error.code) === '23505' || /duplicate key/i.test(error.message)) return;
    console.warn(`[residents] attribution insert failed (${input.tenant.slug}): ${error.message}`);
  }
}

/** Pull an HL order id out of an `exchange.order` response, if present. */
export function oidFromOrderResult(result: unknown): number | null {
  const first = (result as { response?: { data?: { statuses?: unknown[] } } })?.response?.data
    ?.statuses?.[0];
  if (!first || typeof first !== 'object') return null;
  const st = first as { resting?: { oid?: unknown }; filled?: { oid?: unknown } };
  const raw = st.resting?.oid ?? st.filled?.oid;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
