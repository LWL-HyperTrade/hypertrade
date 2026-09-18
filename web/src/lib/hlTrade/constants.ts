/**
 * Pinned builder + fee constants — same defaults as
 * `frontend/src/lib/hyperliquid.ts` and `web/src/lib/config.ts`.
 * Address is never taken from `/builder-config` if it mismatches.
 */
import { DEFAULT_BUILDER_ADDRESS, TENANT_MAX_FEE_TENTHS } from '../config';

export type Hex = `0x${string}`;

export const HL_BUILDER_ADDRESS = DEFAULT_BUILDER_ADDRESS as Hex;
/** HL max builder fee on perps is 0.1% — `docs/HL_BUILDER.md` + builder-codes. */
export const HL_BUILDER_MAX_FEE_RATE = '0.1%' as const;

/**
 * Named API wallet for this Vite desk only.
 * Mobile uses `HyperTrade`. A matching name would deregister that agent
 * (HL nonces-and-api-wallets).
 */
export const WEB_AGENT_NAME = 'HyperTrade Web';

export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HL_SIGNATURE_CHAIN_ID = '0xa4b1' as const;

export function clampTenantFeeTenths(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), TENANT_MAX_FEE_TENTHS);
}

export function pinnedBuilderAddress(apiAddress?: string | null): Hex {
  const pinned = HL_BUILDER_ADDRESS.toLowerCase();
  if (apiAddress && apiAddress.trim().toLowerCase() !== pinned) {
    console.warn('[hlTrade] Ignoring mismatched builder address from API', apiAddress);
  }
  return HL_BUILDER_ADDRESS;
}

/** Order `b` from the tenant row (server-set). Invalid → platform. */
export function orderBuilderAddress(tenantBuilder?: string | null): Hex {
  const raw = (tenantBuilder || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(raw)) return raw as Hex;
  return HL_BUILDER_ADDRESS;
}
