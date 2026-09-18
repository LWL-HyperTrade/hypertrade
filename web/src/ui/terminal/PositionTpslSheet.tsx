import { useEffect, useState } from 'react';
import { displaySymbol, formatPx, formatUsd } from '../../lib/hlMarket';
import { IconClose } from '../icons';

export type PositionTpslTarget = {
  coin: string;
  entrySide: 'long' | 'short';
  entryPx: number;
  markPx: number;
  /** Absolute position size in coin units (for Est. gain / loss). */
  sizeUnits: number;
  existingTp?: number | null;
  existingSl?: number | null;
};

export function PositionTpslSheet({
  target,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  target: PositionTpslTarget | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (tp: number | null, sl: number | null) => void;
}) {
  const [tpPx, setTpPx] = useState('');
  const [slPx, setSlPx] = useState('');

  useEffect(() => {
    if (!target) return;
    setTpPx(target.existingTp != null && target.existingTp > 0 ? String(target.existingTp) : '');
    setSlPx(target.existingSl != null && target.existingSl > 0 ? String(target.existingSl) : '');
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, busy, onClose]);

  if (!target) return null;

  const tp = Number(tpPx);
  const sl = Number(slPx);
  const wantTp = Number.isFinite(tp) && tp > 0;
  const wantSl = Number.isFinite(sl) && sl > 0;
  const size = target.sizeUnits > 0 ? target.sizeUnits : 0;
  const long = target.entrySide === 'long';
  const tpGain =
    wantTp && size > 0
      ? (long ? tp - target.entryPx : target.entryPx - tp) * size
      : null;
  const slLoss =
    wantSl && size > 0
      ? (long ? sl - target.entryPx : target.entryPx - sl) * size
      : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
      />
      <div className="relative w-full max-w-sm rounded-2xl border border-stroke-weak bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-stroke-weak px-4 py-3">
          <div>
            <h2 className="text-[14px] font-bold">TP / SL</h2>
            <p className="text-[11px] text-fg-subtle">
              {displaySymbol(target.coin)} · {long ? 'Long' : 'Short'} · Mark {formatPx(target.markPx)}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-fill-weak disabled:opacity-40"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-fg-subtle">TP Price</span>
              <input
                value={tpPx}
                onChange={(e) => setTpPx(e.target.value)}
                inputMode="decimal"
                placeholder={
                  long ? `Above ${formatPx(target.entryPx)}` : `Below ${formatPx(target.entryPx)}`
                }
                className="field w-full !py-2 text-[13px]"
                disabled={busy}
              />
              <span className="mt-2 block text-[10px] leading-4 text-fg-subtle">
                Gain {tpGain != null && Number.isFinite(tpGain) ? formatUsd(tpGain) : '—'}
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-fg-subtle">SL Price</span>
              <input
                value={slPx}
                onChange={(e) => setSlPx(e.target.value)}
                inputMode="decimal"
                placeholder={
                  long ? `Below ${formatPx(target.entryPx)}` : `Above ${formatPx(target.entryPx)}`
                }
                className="field w-full !py-2 text-[13px]"
                disabled={busy}
              />
              <span className="mt-2 block text-[10px] leading-4 text-fg-subtle">
                Loss {slLoss != null && Number.isFinite(slLoss) ? formatUsd(slLoss) : '—'}
              </span>
            </label>
          </div>
          {error ? <p className="text-[12px] font-semibold text-market-down">{error}</p> : null}
          <button
            type="button"
            disabled={busy || (!wantTp && !wantSl)}
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-40"
            onClick={() => onSubmit(wantTp ? tp : null, wantSl ? sl : null)}
          >
            {busy ? 'Saving…' : 'Set TP / SL'}
          </button>
        </div>
      </div>
    </div>
  );
}
