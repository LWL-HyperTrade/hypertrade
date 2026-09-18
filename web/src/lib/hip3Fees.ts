/**
 * Hyperliquid protocol fee math (builder fee is NOT included).
 * Port of frontend/src/lib/hip3Fees.ts for BuilderPad web terminal.
 */

export type GrowthModeInput = boolean | string | null | undefined;

export function isGrowthModeEnabled(value: GrowthModeInput): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'enabled' || s === 'true' || s === '1';
}

export function parseDeployerFeeScale(
  value: number | string | null | undefined,
  fallback = 1,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function hip3ScaleFromDeployerFeeScale(deployerFeeScale: number): number {
  if (!Number.isFinite(deployerFeeScale) || deployerFeeScale < 0) return 2;
  return deployerFeeScale < 1 ? deployerFeeScale + 1 : deployerFeeScale * 2;
}

export type ProtocolFeeRatesInput = {
  takerRate: number;
  makerRate: number;
  activeReferralDiscount?: number;
  kind: 'perp' | 'spot';
  isStablePair?: boolean;
  isHip3?: boolean;
  deployerFeeScale?: number | string | null;
  growthMode?: GrowthModeInput;
};

export type ProtocolFeeRates = {
  takerRate: number;
  makerRate: number;
  hip3Scale: number;
  growthModeScale: number;
  deployerFeeScale: number;
  growthMode: boolean;
};

export function computeProtocolFeeRates(input: ProtocolFeeRatesInput): ProtocolFeeRates {
  const referral = clamp01(input.activeReferralDiscount ?? 0);
  const stableScale = input.kind === 'spot' && input.isStablePair ? 0.2 : 1;

  const deployerFeeScale =
    input.isHip3 && input.kind === 'perp'
      ? parseDeployerFeeScale(input.deployerFeeScale, 1)
      : 1;
  const growthMode =
    input.isHip3 && input.kind === 'perp' ? isGrowthModeEnabled(input.growthMode) : false;
  const hip3Scale =
    input.isHip3 && input.kind === 'perp' ? hip3ScaleFromDeployerFeeScale(deployerFeeScale) : 1;
  const growthModeScale = growthMode ? 0.1 : 1;

  const scale = stableScale * hip3Scale * growthModeScale * (1 - referral);

  const baseTaker = Number.isFinite(input.takerRate) ? input.takerRate : 0;
  const baseMaker = Number.isFinite(input.makerRate) ? input.makerRate : 0;

  const takerRate = baseTaker * scale;
  const makerRate = baseMaker > 0 ? baseMaker * scale : baseMaker;

  return {
    takerRate,
    makerRate,
    hip3Scale,
    growthModeScale,
    deployerFeeScale,
    growthMode,
  };
}

export function formatFeePercent(decimalRate: number, digits = 3): string {
  if (!Number.isFinite(decimalRate)) return '--';
  return `${(decimalRate * 100).toFixed(digits)}%`;
}

/** HL stores tenths of a bps. 100 tenths = 10 bps = 0.1%. */
export function builderFeeRateFromTenths(tenths: number): number {
  const n = Number.isFinite(tenths) ? Math.max(0, tenths) : 0;
  return n * 0.00001;
}

export const DEFAULT_PERP_TAKER_RATE = 0.00045;
export const DEFAULT_PERP_MAKER_RATE = 0.00015;
export const DEFAULT_SPOT_TAKER_RATE = 0.0007;
export const DEFAULT_SPOT_MAKER_RATE = 0.0004;

export type FeeAssetLike = {
  isHip3?: boolean;
  growthMode?: GrowthModeInput;
  deployerFeeScale?: number | string | null;
  isSpotOnly?: boolean;
  coin?: string;
};

/** Total all-in rates (HL base + creator builder fee) for UI. */
export function totalTradingFees(
  asset: FeeAssetLike | null | undefined,
  builderFeeTenths: number,
): { maker: number; taker: number } {
  const builder = builderFeeRateFromTenths(builderFeeTenths);
  const isSpot = !!asset?.isSpotOnly;
  const isHip3 = !!asset?.isHip3 || (!!asset?.coin && asset.coin.includes(':'));
  const protocol = computeProtocolFeeRates({
    takerRate: isSpot ? DEFAULT_SPOT_TAKER_RATE : DEFAULT_PERP_TAKER_RATE,
    makerRate: isSpot ? DEFAULT_SPOT_MAKER_RATE : DEFAULT_PERP_MAKER_RATE,
    kind: isSpot ? 'spot' : 'perp',
    isHip3: !isSpot && isHip3,
    deployerFeeScale: asset?.deployerFeeScale,
    growthMode: asset?.growthMode,
  });
  return {
    maker: protocol.makerRate + builder,
    taker: protocol.takerRate + builder,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}
