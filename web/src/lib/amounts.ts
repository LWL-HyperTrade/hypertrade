/**
 * Token amounts as bigints. Floats round (0.00009626 → "0.0001") and then the
 * user types the rounded figure back in and the send fails. Always validate
 * against base units, and show exactly what Max would fill.
 */
import { formatUnits, parseUnits } from 'viem';

/** Decimal places typed by the user (0 for "12" or "12."). */
export function decimalsTyped(raw: string): number {
  const t = raw.trim();
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
}

/**
 * Parse a human amount into base units. `null` when blank, not a number,
 * zero/negative, or has more decimals than the token supports.
 */
export function parseTokenAmount(raw: string, decimals: number): bigint | null {
  const t = raw.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  if (decimalsTyped(t) > decimals) return null;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/**
 * Exact-ish display: floor to `maxShown` decimals, trim zeros. Floor, never
 * round, so the shown value is always spendable. Max fills this same string.
 */
export function formatTokenAmount(units: bigint, decimals: number, maxShown = decimals): string {
  if (units <= 0n) return '0';
  const s = formatUnits(units, decimals);
  const [whole, frac = ''] = s.split('.');
  const cut = frac.slice(0, Math.max(0, maxShown)).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/** Base units for what `formatTokenAmount` shows (floored). */
export function floorTokenAmount(units: bigint, decimals: number, maxShown: number): bigint {
  if (maxShown >= decimals || units <= 0n) return units;
  const step = 10n ** BigInt(decimals - maxShown);
  return (units / step) * step;
}
