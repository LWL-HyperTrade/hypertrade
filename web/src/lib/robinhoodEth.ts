import { formatUnits, type Hex } from 'viem';
import { getRobinhoodPublicClient } from './pons/chain';

export async function fetchRobinhoodEth(
  address: Hex,
): Promise<{ raw: bigint; decimals: number; formatted: number }> {
  const client = getRobinhoodPublicClient();
  const raw = await client.getBalance({ address });
  const decimals = 18;
  return { raw, decimals, formatted: Number(formatUnits(raw, decimals)) };
}

/** Compact ETH amount for the header pill. */
export function formatEth(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0 ETH';
  if (Math.abs(v) < 0.0001) return '<0.0001 ETH';
  if (Math.abs(v) < 1) {
    return `${v.toLocaleString('en-US', { maximumFractionDigits: 4, minimumFractionDigits: 0 })} ETH`;
  }
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 3, minimumFractionDigits: 0 })} ETH`;
}
