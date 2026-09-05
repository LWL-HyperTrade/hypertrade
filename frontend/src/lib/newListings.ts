import type { Asset } from './api';

/**
 * HyperTrade catalog listings, newest first. Prepend a symbol when you ship
 * a new market — "New" sub-filter shows the first 15 matches in this order
 * (scoped to the active parent tab).
 */
export const NEWLY_LISTED_SYMBOLS: readonly string[] = [
  'ANTH',
  'SPCX',
  'PONS',
  'UNITREE',
  'CXMT',
  'SKHY',
  'BOT',
  'LITE',
  'AVGO',
  'MRVL',
  'MRNA',
  'DELL',
  'IBM',
  'CRWV',
  'CRCL',
  'SNDK',
  'DRAM',
];

const NEW_LISTING_RANK = new Map(
  NEWLY_LISTED_SYMBOLS.map((symbol, index) => [symbol.toUpperCase(), index]),
);

function listingKey(asset: Pick<Asset, 'symbol' | 'coin'>): string {
  const raw = String(asset.symbol || asset.coin || '').trim();
  const base = raw.includes(':') ? raw.split(':').pop()! : raw;
  return base.toUpperCase();
}

/** Keep catalog order; cap at *limit* (default 15). */
export function filterNewlyListedAssets(assets: Asset[], limit = 15): Asset[] {
  const out: Asset[] = [];
  for (const asset of assets) {
    if (!NEW_LISTING_RANK.has(listingKey(asset))) continue;
    out.push(asset);
  }
  out.sort(
    (a, b) =>
      (NEW_LISTING_RANK.get(listingKey(a)) ?? Number.MAX_SAFE_INTEGER) -
      (NEW_LISTING_RANK.get(listingKey(b)) ?? Number.MAX_SAFE_INTEGER),
  );
  return out.slice(0, limit);
}
