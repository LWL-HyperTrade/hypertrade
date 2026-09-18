/** Curated HL spot pairs — same list as mobile `SPOT_TOGGLE_WHITELIST`. */
export const SPOT_TOGGLE_WHITELIST = new Set<string>([
  'BTC',
  'ETH',
  'HYPE',
  'SOL',
  'ZEC',
  'ENA',
  'MON',
  'XPL',
  'PUMP',
  'KNTQ',
  'USDT',
  'GOLDSPOT',
  'XAUT',
]);

export function spotToggleBase(coin: string, symbol?: string | null): string {
  const raw = (symbol || coin || '').toUpperCase();
  const base = raw.includes(':') ? raw.split(':').pop() || raw : raw;
  return base.replace(/-USDC$/i, '').replace(/\/USDC$/i, '');
}

export function canToggleSpot(coin: string, symbol?: string | null, isSpotOnly?: boolean): boolean {
  if (isSpotOnly) return true;
  const base = spotToggleBase(coin, symbol);
  const noU = base.startsWith('U') && base.length > 1 ? base.slice(1) : base;
  return SPOT_TOGGLE_WHITELIST.has(base) || SPOT_TOGGLE_WHITELIST.has(noU);
}

export function spotLookupName(coin: string, symbol?: string | null): string {
  const base = spotToggleBase(coin, symbol);
  if (base === 'GOLDSPOT') return 'XAUT';
  return base;
}
