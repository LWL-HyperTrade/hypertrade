import { useEffect, useState } from 'react';
import { displaySymbol, formatPx, formatUsd, type OpenOrder } from '../../lib/hlMarket';
import { IconClose } from '../icons';

export type EditOrderTarget = {
  order: OpenOrder;
  displaySz: number;
  markPx: number | null;
};

function typeLabel(o: OpenOrder): string {
  if (o.tpsl === 'tp') return 'Take Profit';
  if (o.tpsl === 'sl') return 'Stop Loss';
  if (o.isTrigger) return 'Trigger';
  return o.orderType || 'Limit';
}

export function EditOrderSheet({
  target,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  target: EditOrderTarget | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (px: number, size: number) => void;
}) {
  const [pxText, setPxText] = useState('');
  const [szText, setSzText] = useState('');

  useEffect(() => {
    if (!target) return;
    const o = target.order;
    const px = o.isTrigger && o.triggerPx != null && o.triggerPx > 0 ? o.triggerPx : o.limitPx;
    setPxText(Number.isFinite(px) && px > 0 ? String(px) : '');
    setSzText(target.displaySz > 0 ? String(target.displaySz) : '');
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

  const o = target.order;
  const isTrigger = o.isTrigger || o.isPositionTpsl || o.tpsl === 'tp' || o.tpsl === 'sl';
  const px = Number(pxText);
  const sz = Number(szText);
  const pxOk = Number.isFinite(px) && px > 0;
  const szOk = Number.isFinite(sz) && sz > 0;
  const notional = pxOk && szOk ? px * sz : null;
  const buy = o.side === 'B';
  const mark = target.markPx;
  const wouldTake =
    !isTrigger &&
    pxOk &&
    mark != null &&
    mark > 0 &&
    (buy ? px >= mark : px <= mark);

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
            <h2 className="text-[14px] font-bold">Edit order</h2>
            <p className="text-[11px] text-fg-subtle">
              {displaySymbol(o.coin)} · {typeLabel(o)} · {buy ? 'Long' : 'Short'}
              {mark != null && mark > 0 ? ` · Mark ${formatPx(mark)}` : ''}
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
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold text-fg-subtle">
              {isTrigger ? 'Trigger Price' : 'Limit Price'}
            </span>
            <input
              value={pxText}
              onChange={(e) => setPxText(e.target.value)}
              inputMode="decimal"
              className="field w-full !py-2 text-[13px]"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold text-fg-subtle">Size</span>
            <input
              value={szText}
              onChange={(e) => setSzText(e.target.value)}
              inputMode="decimal"
              className="field w-full !py-2 text-[13px]"
              disabled={busy || isTrigger}
            />
            <span className="mt-2 block text-[10px] leading-4 text-fg-subtle">
              {isTrigger
                ? 'Trigger size follows the live position.'
                : notional != null
                  ? `≈ ${formatUsd(notional)}`
                  : '—'}
            </span>
          </label>
          {wouldTake ? (
            <p className="text-[12px] font-semibold text-market-down">
              Post-only price would immediately take liquidity. Adjust price and try again.
            </p>
          ) : error ? (
            <p className="text-[12px] font-semibold text-market-down">{error}</p>
          ) : null}
          <button
            type="button"
            disabled={busy || !pxOk || !szOk || wouldTake}
            className="btn-primary w-full py-2.5 text-[13px] disabled:opacity-40"
            onClick={() => onSubmit(px, sz)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
