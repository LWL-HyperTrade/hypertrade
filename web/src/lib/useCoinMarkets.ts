import { useQuery } from '@tanstack/react-query';
import { fetchCoinMarkets, type CoinMarket } from './pons/market';
import type { TenantCoin } from './tenants';

export type { CoinMarket };

export function useCoinMarkets(coins: Array<TenantCoin | null | undefined>) {
  const list = coins.filter((c): c is TenantCoin => !!c?.token);
  const key = list
    .map((c) => c.token.toLowerCase())
    .sort()
    .join(',');
  return useQuery({
    queryKey: ['coin-markets', key],
    enabled: list.length > 0,
    queryFn: () => fetchCoinMarkets(list),
    staleTime: 30_000,
    refetchInterval: 45_000,
  });
}

export function marketFor(
  map: Record<string, CoinMarket> | undefined,
  token?: string | null,
): CoinMarket | undefined {
  if (!map || !token) return undefined;
  return map[token.toLowerCase()];
}
