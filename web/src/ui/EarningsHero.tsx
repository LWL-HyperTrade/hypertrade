import { BUILDER_FEE_CHIPS, builderTakeUsd, formatCompactUsd, formatFeePercent, formatWholeUsd, VOLUME_PRESETS } from '../lib/earnings';
import { IconBolt, IconLock } from './icons';
import { RollingUsd } from './Rolling';

const FEE_CHIPS = BUILDER_FEE_CHIPS;

/**
 * The money slide. Fee picker and the number it produces live in the same card
 * so every click rolls the figure right next to your thumb.
 */
export function EarningsHero({
  feeTenths,
  onFee,
  notional,
  onNotional,
  liveOwn,
}: {
  feeTenths: number;
  onFee: (tenths: number) => void;
  notional: number;
  onNotional: (n: number) => void;
  liveOwn: boolean;
}) {
  const take = builderTakeUsd(feeTenths, notional);
  const perMillion = builderTakeUsd(feeTenths, 1_000_000);

  return (
    <section className="card-money p-5 sm:p-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <div className="flex h-6 items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-brand">
            <IconBolt size={14} />
            Your cut at {formatCompactUsd(notional)} volume
          </div>
          <div className="display mt-2 text-[44px] sm:text-[64px]">
            <RollingUsd value={take} format={formatWholeUsd} className="text-hype" />
          </div>
          <p className="mt-3 max-w-md text-[13px] leading-5 text-fg-muted">
            <strong className="text-fg">{formatFeePercent(feeTenths)}</strong> on every fill ={' '}
            <strong className="text-fg">{formatCompactUsd(perMillion)}</strong> per $1M traded.{' '}
            {liveOwn ? (
              <span className="text-success">Paid straight to your wallet.</span>
            ) : (
              <span>
                Goes to <span className="text-fg">you</span> once you activate.
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2 lg:items-end">
          <div>
            <div className="label mb-1.5 h-6 lg:justify-end">
              <span className="req">Your fee</span>
              <span className="text-[10px] font-semibold text-fg-subtle">max {formatFeePercent(100)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 lg:justify-end">
              {FEE_CHIPS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="chip !px-2.5 !py-1 !text-[12px]"
                  aria-pressed={feeTenths === n}
                  onClick={() => onFee(n)}
                >
                  {formatFeePercent(n)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-0.5 text-[11px] font-bold text-fg-subtle lg:justify-end">
            <span className="mr-1">Volume</span>
            {VOLUME_PRESETS.map((v) => (
              <button
                key={v.notional}
                type="button"
                onClick={() => onNotional(v.notional)}
                className={`rounded-md px-1.5 py-0.5 transition-colors ${
                  notional === v.notional ? 'bg-fill-weak text-fg' : 'hover:text-fg'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {feeTenths === 0 ? (
        <p className="mt-4 inline-flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] font-semibold text-warning">
          <IconLock size={13} />
          0% means you earn nothing from trading.
        </p>
      ) : null}
    </section>
  );
}
