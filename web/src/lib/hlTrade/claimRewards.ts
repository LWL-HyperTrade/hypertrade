/**
 * Hyperliquid builder fees claim through the referral reward action.
 *
 * Docs (builder-codes): "Builders can claim fees from builder codes through
 * the usual referral reward claim process."
 * Info: `{ type: "referral", user }` → `unclaimedRewards` / `builderRewards`.
 * Exchange: `{ type: "claimRewards" }` — signed by the builder EOA (HD 1),
 * not an agent. Pays into the builder's spot USDC. HL requires > $1.
 */
import { getHlInfoClient, withUserSignedExchange } from './clients';
import type { Hex } from './constants';
import type { Eip1193Provider } from './wallet';

export const HL_CLAIM_MIN_USD = 1;

export type HlRewards = {
  unclaimed: number;
  claimed: number;
  /** Lifetime builder-code take (all interfaces). */
  builder: number;
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchHlRewards(user: Hex): Promise<HlRewards> {
  const raw = await getHlInfoClient().referral({ user });
  return {
    unclaimed: num(raw.unclaimedRewards),
    claimed: num(raw.claimedRewards),
    builder: num(raw.builderRewards),
  };
}

/** Sign `claimRewards` with the builder (HD 1 or imported MetaMask). */
export async function claimHlRewards(args: {
  builder: Hex;
  provider: Eip1193Provider;
}): Promise<void> {
  await withUserSignedExchange(args.provider, args.builder, (exchange) =>
    exchange.claimRewards(),
  );
}
