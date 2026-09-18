import { useQuery } from '@tanstack/react-query';
import { fetchClearinghouse, fetchOpenOrders } from './hlMarket';

export function useHlAccount(address: string | null) {
  const clearing = useQuery({
    queryKey: ['hl', 'clearinghouse', address],
    enabled: !!address,
    queryFn: () => fetchClearinghouse(address!),
    refetchInterval: 8_000,
  });
  const orders = useQuery({
    queryKey: ['hl', 'openOrders', address],
    enabled: !!address,
    queryFn: () => fetchOpenOrders(address!),
    refetchInterval: 8_000,
  });
  return {
    clearing: clearing.data ?? null,
    orders: orders.data ?? [],
    loading: !!address && (clearing.isLoading || orders.isLoading),
  };
}
