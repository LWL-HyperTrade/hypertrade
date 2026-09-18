import type { AssetRow } from '../../lib/tenants';

function keys(coin: string): string[] {
  const raw = String(coin ?? '').trim();
  if (!raw) return [];
  const out = [raw, raw.toUpperCase()];
  if (raw.includes(':')) {
    const base = raw.split(':').pop() || '';
    out.push(base, base.toUpperCase());
  }
  return out;
}

export function catalogAllows(catalog: string[], coin: string, assets: AssetRow[]): boolean {
  if (!catalog.length) return true;
  const allowed = new Set(catalog.flatMap(keys));
  const coinKeys = keys(coin);
  const candidates = [coin, ...coinKeys];
  for (const a of assets) {
    const assetKeys = [...keys(a.coin), ...(a.symbol ? keys(a.symbol) : [])];
    const overlap = assetKeys.some((k) => coinKeys.includes(k) || k === coin);
    if (a.coin === coin || a.symbol === coin || overlap) {
      candidates.push(a.coin, a.symbol, ...assetKeys);
    }
  }
  return candidates.some((c) => c && (allowed.has(c) || allowed.has(c.toUpperCase())));
}

type ListedMarket = {
  coin: string;
  symbol?: string;
  isSpotOnly?: boolean;
};

/**
 * Map a position / order / URL coin onto a market this desk actually lists.
 * HIP-3 (and a future HIP-4 dex:ticker) often show up as `xyz:CL` while the
 * catalog may store that same book as `xyz:CL` or a bare `CL` — never navigate
 * to a coin that is not in `markets` (that would 404 or silently fall back).
 */
export function resolveListedMarket<T extends ListedMarket>(markets: T[], coin: string): T | null {
  const raw = String(coin ?? '').trim();
  if (!raw || !markets.length) return null;

  const rawUpper = raw.toUpperCase();
  const exact = markets.find((m) => m.coin.toUpperCase() === rawUpper);
  if (exact) return exact;

  const want = new Set(keys(raw).map((k) => k.toUpperCase()));
  const hits = markets.filter((m) => {
    const mk = [...keys(m.coin), ...(m.symbol ? keys(m.symbol) : [])].map((k) => k.toUpperCase());
    return mk.some((k) => want.has(k));
  });
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];

  const colon = raw.indexOf(':');
  const dex = colon > 0 ? raw.slice(0, colon).toUpperCase() : '';
  if (dex) {
    const sameDex = hits.filter((m) => m.coin.toUpperCase().startsWith(`${dex}:`));
    if (sameDex.length === 1) return sameDex[0];
    if (sameDex.length > 1) return sameDex.find((m) => !m.isSpotOnly) ?? sameDex[0];
  }
  return hits.find((m) => !m.isSpotOnly) ?? hits[0];
}
