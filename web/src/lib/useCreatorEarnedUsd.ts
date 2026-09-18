import { useQuery } from '@tanstack/react-query';
import { fetchCreatorEarnedUsd } from './pons/reads';
import type { TenantCoin } from './tenants';

/** Batch Pons creator fee USD (escrow + unswept curve) for directory cards. */
export function useCreatorEarnedUsd(coins: Array<TenantCoin | null | undefined>) {
  // External showcase coins use `earned_usd` on the card — skip Pons reads.
  const list = coins.filter(
    (c): c is TenantCoin => !!c?.token && c.source !== 'external',
  );
  const key = list
    .map((c) => `${c.token.toLowerCase()}:${(c.fee_recipient || '').toLowerCase()}`)
    .sort()
    .join(',');
  return useQuery({
    queryKey: ['pons-earned-usd-batch', key],
    enabled: list.length > 0,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(
        list.map(async (c) => {
          out[c.token.toLowerCase()] = await fetchCreatorEarnedUsd(c);
        }),
      );
      return out;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function earnedFor(
  map: Record<string, number> | undefined,
  token?: string | null,
): number | null {
  if (!map || !token) return null;
  const n = map[token.toLowerCase()];
  return Number.isFinite(n) ? n : null;
}
