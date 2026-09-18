/** Place-time builder take: notional × tenths / 100000. Same as tenant est fee. */
export const PREVIEW_NOTIONAL_USD = 1_000_000_000;

/** Pons launch metadata caps (matches their create UI / MetadataTooLong). */
export const PONS_NAME_MAX = 60;
export const PONS_SYMBOL_MAX = 20;
export const PONS_DESCRIPTION_MAX = 256;

/** Volume presets the wizard lets creators flip between. $1B is the default story. */
export const VOLUME_PRESETS: { label: string; notional: number }[] = [
  { label: '$100M', notional: 100_000_000 },
  { label: '$1B', notional: PREVIEW_NOTIONAL_USD },
  { label: '$10B', notional: 10_000_000_000 },
];

/** Same chips as the create wizard. 30 tenths = 0.03%. */
export const BUILDER_FEE_CHIPS = [0, 10, 30, 50, 100] as const;

/** Independent 0–100 chips. Buybacks = of the fee; burn = of that buyback. */
export const PLEDGE_CHIPS = [0, 10, 25, 50, 75, 100] as const;

export function clampPledgePct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Share of the builder fee kept as cash — burn does not reduce this. */
export function keepPct(buyback: number): number {
  return Math.max(0, 100 - clampPledgePct(buyback));
}

export function formatPledgePercent(pct: number): string {
  return `${clampPledgePct(pct)}%`;
}

export function builderTakeUsd(feeTenths: number, notionalUsd = PREVIEW_NOTIONAL_USD): number {
  const tenths = Number.isFinite(feeTenths) ? Math.max(0, Math.floor(feeTenths)) : 0;
  return (tenths / 100_000) * notionalUsd;
}

/** HL stores tenths of a bps. 100 tenths = 10 bps = 0.1%. */
export function formatFeePercent(tenths: number): string {
  const n = Number.isFinite(tenths) ? Math.max(0, tenths) : 0;
  const pct = n * 0.001;
  if (pct === 0) return '0%';
  const digits = pct >= 0.1 ? 1 : pct >= 0.01 ? 2 : 3;
  return `${pct.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** Pons `creatorTaxBps` — 100 = 1%. */
export function formatTaxBps(bps: number | null | undefined): string {
  const n = Number.isFinite(Number(bps)) ? Math.max(0, Number(bps)) : 0;
  const pct = n / 100;
  if (pct === 0) return '0%';
  const digits = pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export function formatCompactUsd(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.5) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (v: number, digits: number) =>
    v.toFixed(digits).replace(/\.?0+$/, '');
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000, 1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/** Fee / earned totals — show cents under $1k; dust under $0.10 reads as $0. */
export function formatEarnedUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 0.1) return '$0';
  if (abs < 1000) return `${sign}$${abs.toFixed(2)}`;
  const trim = (v: number, digits: number) => v.toFixed(digits).replace(/\.?0+$/, '');
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000, 2)}M`;
  return `${sign}$${trim(abs / 1_000, 1)}K`;
}

/** Holder / order counts. Null → em dash. */
export function formatCompactCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (v: number, digits: number) => v.toFixed(digits).replace(/\.?0+$/, '');
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000, 1)}K`;
  return `${sign}${Math.round(abs)}`;
}

/** Token price. Keeps enough digits for sub-cent curve quotes. */
export function formatUsdPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '$0';
  if (abs < 1e-6) return `$${n.toExponential(1)}`;
  if (abs < 0.01) {
    const s = abs.toPrecision(3);
    return `$${Number(s)}`;
  }
  if (abs < 1) return `$${abs.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  if (abs < 1_000) return `$${abs.toFixed(abs >= 100 ? 2 : 2)}`;
  return formatCompactUsd(n);
}

/** 24h change, e.g. +12.4% / -3.1%. Null → em dash. */
export function formatSignedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  const digits = Math.abs(n) >= 10 ? 1 : 2;
  return `${sign}${n.toFixed(digits)}%`;
}

/** Pons-style launch age: now, 1h ago, 1d ago. */
export function relativeAgo(iso?: string | null): string {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (mins < 2) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Full-precision USD for the rolling hero, e.g. $500,000. */
export function formatWholeUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function suggestedTokenSymbol(name: string): string {
  const compact = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (compact.length >= 3) return compact.slice(0, Math.min(8, PONS_SYMBOL_MAX));
  const initials = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
  const s = (initials || compact || 'TOKEN').slice(0, 6);
  return s.length >= 2 ? s : 'TOKEN';
}

export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
