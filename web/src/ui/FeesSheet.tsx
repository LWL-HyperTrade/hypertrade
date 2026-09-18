import { useMemo } from 'react';
import type { AssetRow } from '../lib/tenants';
import {
  DEFAULT_PERP_MAKER_RATE,
  DEFAULT_PERP_TAKER_RATE,
  DEFAULT_SPOT_MAKER_RATE,
  DEFAULT_SPOT_TAKER_RATE,
  builderFeeRateFromTenths,
  computeProtocolFeeRates,
  formatFeePercent,
} from '../lib/hip3Fees';
import { formatPledgePercent } from '../lib/earnings';
import { IconClose } from './icons';

type Props = {
  builderFeeTenths: number;
  buybackPct?: number;
  burnPct?: number;
  assets: AssetRow[];
  onClose: () => void;
};

type FeeRow = {
  label: string;
  samples: string;
  taker: string;
  maker: string;
};

const OTHER_FEES: { label: string; value: string; free?: boolean }[] = [
  { label: 'Wallet creation', value: 'Free', free: true },
  { label: 'Deposits', value: 'Free', free: true },
  { label: 'Wallet → Trade', value: 'Free', free: true },
  { label: 'Send on Hyperliquid', value: 'Free', free: true },
  { label: 'Trade → Wallet', value: '1 USDC' },
  { label: 'Withdrawals', value: 'Free', free: true },
];

function formatRateRange(rates: number[], digits = 3): string {
  if (!rates.length) return '--';
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  if (Math.abs(max - min) < 1e-10) return formatFeePercent(min, digits);
  return `${formatFeePercent(min, digits)}–${formatFeePercent(max, digits)}`;
}

function sampleSymbols(assets: AssetRow[], max = 3): string {
  const names = assets.map((a) => a.symbol || a.coin.split(':').pop() || a.coin).filter(Boolean);
  if (!names.length) return '—';
  const shown = names.slice(0, max);
  return names.length > max ? `${shown.join(', ')}…` : shown.join(', ');
}

function ratesForAssets(
  assets: AssetRow[],
  builderRate: number,
  kind: 'perp' | 'spot',
): { takers: number[]; makers: number[] } {
  const takers: number[] = [];
  const makers: number[] = [];
  for (const a of assets) {
    const isHip3 = kind === 'perp' && (!!a.isHip3 || a.coin.includes(':'));
    const protocol = computeProtocolFeeRates({
      takerRate: kind === 'spot' ? DEFAULT_SPOT_TAKER_RATE : DEFAULT_PERP_TAKER_RATE,
      makerRate: kind === 'spot' ? DEFAULT_SPOT_MAKER_RATE : DEFAULT_PERP_MAKER_RATE,
      kind,
      isHip3,
      deployerFeeScale: a.deployerFeeScale,
      growthMode: a.growthMode,
    });
    takers.push(protocol.takerRate + builderRate);
    makers.push(protocol.makerRate + builderRate);
  }
  return { takers, makers };
}

/**
 * Transparent fee sheet: all-in maker/taker by market class + deposit/withdraw rails.
 * Mirrors mobile fees.tsx (trading + Trade→Wallet 1 USDC).
 */
export function FeesSheet({ builderFeeTenths, buybackPct = 0, burnPct = 0, assets, onClose }: Props) {
  const builderRate = builderFeeRateFromTenths(builderFeeTenths);

  const rows: FeeRow[] = useMemo(() => {
    const majors = assets.filter((a) => !a.isHip3 && !a.coin.includes(':') && a.category === 'crypto');
    const forex = assets.filter((a) => a.category === 'forex');
    const equities = assets.filter(
      (a) => a.category === 'stock' || a.category === 'equity' || a.category === 'tradfi',
    );
    const commodities = assets.filter((a) => a.category === 'commodity');

    const majorRates = ratesForAssets(
      majors.length ? majors.slice(0, 8) : [{ coin: 'BTC', name: 'BTC', symbol: 'BTC', category: 'crypto' }],
      builderRate,
      'perp',
    );
    const forexRates = ratesForAssets(
      forex.length ? forex : [{ coin: 'xyz:EUR', name: 'EUR', symbol: 'EUR', category: 'forex', isHip3: true }],
      builderRate,
      'perp',
    );
    const equityRates = ratesForAssets(
      equities.length
        ? equities
        : [
            {
              coin: 'xyz:TSLA',
              name: 'TSLA',
              symbol: 'TSLA',
              category: 'stock',
              isHip3: true,
              growthMode: true,
              deployerFeeScale: 1,
            },
          ],
      builderRate,
      'perp',
    );
    const commodityRates = ratesForAssets(
      commodities.length
        ? commodities
        : [{ coin: 'xyz:GOLD', name: 'GOLD', symbol: 'GOLD', category: 'commodity', isHip3: true, deployerFeeScale: 1 }],
      builderRate,
      'perp',
    );
    const spotRates = ratesForAssets(
      [{ coin: 'BTC', name: 'BTC', symbol: 'BTC', category: 'crypto', isSpotOnly: true }],
      builderRate,
      'spot',
    );

    return [
      {
        label: 'Crypto perps',
        samples: sampleSymbols(majors.length ? majors : [{ coin: 'BTC', name: 'BTC', symbol: 'BTC', category: 'crypto' }]),
        taker: formatRateRange(majorRates.takers),
        maker: formatRateRange(majorRates.makers),
      },
      {
        label: 'Forex perps',
        samples: sampleSymbols(forex.length ? forex : [{ coin: 'EUR', name: 'EUR', symbol: 'EUR', category: 'forex' }]),
        taker: formatRateRange(forexRates.takers),
        maker: formatRateRange(forexRates.makers),
      },
      {
        label: 'Stock perps',
        samples: sampleSymbols(equities.length ? equities : [{ coin: 'TSLA', name: 'TSLA', symbol: 'TSLA', category: 'stock' }]),
        taker: formatRateRange(equityRates.takers),
        maker: formatRateRange(equityRates.makers),
      },
      {
        label: 'Commodity perps',
        samples: sampleSymbols(
          commodities.length ? commodities : [{ coin: 'GOLD', name: 'GOLD', symbol: 'GOLD', category: 'commodity' }],
        ),
        taker: formatRateRange(commodityRates.takers),
        maker: formatRateRange(commodityRates.makers),
      },
      {
        label: 'Spot',
        samples: 'BTC, ETH, SOL…',
        taker: formatRateRange(spotRates.takers),
        maker: formatRateRange(spotRates.makers),
      },
    ];
  }, [assets, builderRate]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-3 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-md overflow-auto rounded-lg border border-stroke-weak bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Fees"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-stroke-weak bg-surface px-4 py-3">
          <h2 className="text-[15px] font-extrabold tracking-tight">Fees</h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <p className="text-[12px] leading-5 text-fg-muted">
            Maker / taker below are all-in: Hyperliquid base fee + this app&apos;s builder fee (
            {formatFeePercent(builderRate)}).
          </p>
          <p className="text-[12px] leading-5 text-fg-muted">
            Of that builder fee, the creator pledges {formatPledgePercent(buybackPct)} to buybacks.
            Of that buyback, {formatPledgePercent(burnPct)} is burned. That is a promise, not
            on-chain.
          </p>

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-fg-subtle">Trading</div>
            <div className="grid grid-cols-[1fr_64px_64px] gap-x-2 border-b border-stroke-weak pb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
              <span>Market</span>
              <span className="text-right">Taker</span>
              <span className="text-right">Maker</span>
            </div>
            {rows.map((row, i) => (
              <div
                key={row.label}
                className={`grid grid-cols-[1fr_64px_64px] gap-x-2 py-2 ${i % 2 === 0 ? 'bg-fill-weaker/40' : ''}`}
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-fg">{row.label}</div>
                  <div className="truncate text-[10px] text-fg-subtle">{row.samples}</div>
                </div>
                <span className="tabular self-center text-right text-[12px] font-semibold">{row.taker}</span>
                <span className="tabular self-center text-right text-[12px] font-semibold">{row.maker}</span>
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-fg-subtle">Transfers</div>
            {OTHER_FEES.map((item, i) => (
              <div
                key={item.label}
                className={`flex items-center justify-between py-2 text-[12px] ${i % 2 === 0 ? 'bg-fill-weaker/40' : ''}`}
              >
                <span className="text-fg-muted">{item.label}</span>
                <span className={`font-semibold tabular ${item.free ? 'text-market-up' : 'text-fg'}`}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
