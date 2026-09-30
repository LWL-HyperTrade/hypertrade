/**
 * Resident wallet (HD 2) HL ceremonies — docs/RESIDENTS.md.
 *
 * Port of the mobile activate flow (`approveNamedAgent` in
 * frontend/src/lib/hyperliquid.ts) plus the builder-fee approval the desk
 * already does for HD 0 in `setup.ts`. The resident EOA signs both itself; the
 * backend-minted agent key (`htai-…`) then trades on its behalf from the worker.
 *
 * Never call these with the trade (HD 0) or builder (HD 1) wallet.
 */
import { HL_BUILDER_ADDRESS, HL_BUILDER_MAX_FEE_RATE, orderBuilderAddress, type Hex } from './constants';
import { getHlInfoClient, hlInfo, withUserSignedExchange } from './clients';
import { getApprovedBuilderFeeTenths, listHlExtraAgents } from './setup';
import type { Eip1193Provider } from './wallet';

export { listHlExtraAgents };

/** Master (resident wallet) approves the backend-minted named agent. Idempotent. */
export async function approveResidentAgent(args: {
  provider: Eip1193Provider;
  residentAddress: Hex;
  agentAddress: Hex;
  agentName: string;
}): Promise<void> {
  const extras = await listHlExtraAgents(args.residentAddress);
  const already = extras.some((a) => a.address.toLowerCase() === args.agentAddress.toLowerCase());
  if (already) return;
  await withUserSignedExchange(args.provider, args.residentAddress, (exchange) =>
    exchange.approveAgent({ agentAddress: args.agentAddress, agentName: args.agentName }),
  );
}

/** Same as mobile `revokeNamedAgent`: approving the name with the zero address frees the slot. */
export async function revokeResidentAgent(args: {
  provider: Eip1193Provider;
  residentAddress: Hex;
  agentName: string;
}): Promise<void> {
  await withUserSignedExchange(args.provider, args.residentAddress, (exchange) =>
    exchange.approveAgent({
      agentAddress: '0x0000000000000000000000000000000000000000',
      agentName: args.agentName,
    }),
  );
}

export async function isResidentAgentApproved(residentAddress: Hex, agentAddress: Hex): Promise<boolean> {
  const extras = await listHlExtraAgents(residentAddress);
  return extras.some((a) => a.address.toLowerCase() === agentAddress.toLowerCase());
}

const BUILDER_MIN_PERP_USD = 100;

/**
 * Builder the resident should approve and pay.
 * A funded Standard app builder keeps its own fee. Anyone else — preview, or
 * an own wallet without the 100 USDC Hyperliquid requires — credits the
 * BuilderPad builder. A unified wallet cannot be a builder.
 */
export async function resolveResidentBuilder(tenantBuilder?: string | null): Promise<Hex> {
  const own = orderBuilderAddress(tenantBuilder);
  if (own.toLowerCase() === HL_BUILDER_ADDRESS.toLowerCase()) return HL_BUILDER_ADDRESS;
  try {
    const info = getHlInfoClient();
    const [state, absRaw] = await Promise.all([
      info.clearinghouseState({ user: own }),
      hlInfo<unknown>({ type: 'userAbstraction', user: own }).catch(() => null),
    ]);
    const equity = Number((state as { marginSummary?: { accountValue?: string } }).marginSummary?.accountValue ?? 0) || 0;
    let abstraction: string | null = null;
    if (typeof absRaw === 'string') abstraction = absRaw;
    else if (absRaw && typeof absRaw === 'object' && 'abstraction' in absRaw) {
      abstraction = String((absRaw as { abstraction?: unknown }).abstraction ?? '') || null;
    }
    const unified = abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin';
    if (!unified && equity + 1e-9 >= BUILDER_MIN_PERP_USD) return own;
  } catch {
    /* HL blip — credit the platform builder rather than blocking go-live. */
  }
  return HL_BUILDER_ADDRESS;
}

/**
 * Approve the app's builder at HL's 0.1% max once, so later fee edits
 * (0–10 bps, append-only) never need a second signature. Returns true when a
 * signature was sent.
 */
export async function ensureResidentBuilderApproved(args: {
  provider: Eip1193Provider;
  residentAddress: Hex;
  builderAddress?: string | null;
  requiredFeeTenths: number;
}): Promise<boolean> {
  const builder = orderBuilderAddress(args.builderAddress);
  let approved = 0;
  try {
    approved = await getApprovedBuilderFeeTenths(args.residentAddress, builder);
  } catch {
    approved = 0;
  }
  if (approved > 0 && approved >= args.requiredFeeTenths) return false;
  await withUserSignedExchange(args.provider, args.residentAddress, (exchange) =>
    exchange.approveBuilderFee({ builder, maxFeeRate: HL_BUILDER_MAX_FEE_RATE }),
  );
  return true;
}

export type ResidentEquity = {
  perpUsd: number;
  spotUsdcUsd: number;
  totalUsd: number;
  abstraction: string | null;
};

/**
 * Same figure the backend uses for the $100 activate floor
 * (`ai_agents.get_hl_account_value`): perp account value + spot USDC.
 */
export async function fetchResidentEquity(residentAddress: Hex): Promise<ResidentEquity> {
  const info = getHlInfoClient();
  const [state, spot, abstractionRaw] = await Promise.all([
    info.clearinghouseState({ user: residentAddress }).catch(() => null),
    info.spotClearinghouseState({ user: residentAddress }).catch(() => null),
    hlInfo<unknown>({ type: 'userAbstraction', user: residentAddress }).catch(() => null),
  ]);
  const perp = Number((state as { marginSummary?: { accountValue?: string } } | null)?.marginSummary?.accountValue ?? 0) || 0;
  let spotUsdc = 0;
  const balances = (spot as { balances?: Array<{ coin?: string; total?: string }> } | null)?.balances ?? [];
  for (const b of balances) {
    if (String(b.coin ?? '').toUpperCase() === 'USDC') spotUsdc += Number(b.total ?? 0) || 0;
  }
  let abstraction: string | null = null;
  if (typeof abstractionRaw === 'string') abstraction = abstractionRaw;
  else if (abstractionRaw && typeof abstractionRaw === 'object' && 'abstraction' in abstractionRaw) {
    abstraction = String((abstractionRaw as { abstraction?: unknown }).abstraction ?? '') || null;
  }
  return { perpUsd: perp, spotUsdcUsd: spotUsdc, totalUsd: perp + spotUsdc, abstraction };
}

/**
 * Unified account on the resident wallet so HIP-3 (xyz:*) symbols trade from
 * spot USDC like the desk. Optional for main-dex-only residents; harmless twice.
 */
export async function ensureResidentUnified(args: {
  provider: Eip1193Provider;
  residentAddress: Hex;
}): Promise<boolean> {
  const { abstraction } = await fetchResidentEquity(args.residentAddress);
  if (abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin') return false;
  await withUserSignedExchange(args.provider, args.residentAddress, (exchange) =>
    exchange.userSetAbstraction({ user: args.residentAddress, abstraction: 'unifiedAccount' }),
  );
  return true;
}
