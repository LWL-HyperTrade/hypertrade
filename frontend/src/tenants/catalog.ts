import type { Asset } from '../lib/api';

function norm(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase();
}

function catalogKeys(coin: string): string[] {
  const raw = String(coin ?? '').trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();
  const keys = [raw, upper];
  if (raw.includes(':')) {
    const base = raw.split(':').pop() || '';
    keys.push(base, base.toUpperCase());
  }
  return keys;
}

export function assetMatchesCatalog(asset: Pick<Asset, 'coin' | 'symbol'>, catalog: string[]): boolean {
  if (!catalog.length) return false;
  const allowed = new Set(catalog.flatMap(catalogKeys));
  const candidates = [
    norm(asset.coin),
    norm(asset.symbol),
    asset.coin,
    asset.symbol,
  ].filter(Boolean) as string[];
  if (asset.coin?.includes(':')) {
    candidates.push(norm(asset.coin.split(':').pop()));
  }
  return candidates.some((c) => allowed.has(c) || allowed.has(String(c).toUpperCase()));
}

export function filterAssetsForTenant<T extends Pick<Asset, 'coin' | 'symbol'>>(
  assets: T[],
  catalog: string[],
): T[] {
  if (!catalog.length) return [];
  return assets.filter((a) => assetMatchesCatalog(a, catalog));
}

export function feeTenthsToBps(tenths: number): number {
  return tenths / 10;
}

export function feeTenthsToPercentLabel(tenths: number): string {
  const pct = tenths * 0.001;
  return `${pct.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}
