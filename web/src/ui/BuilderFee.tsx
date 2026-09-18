import { useEffect, useState, type ReactNode } from 'react';
import { BUILDER_FEE_CHIPS, formatFeePercent, relativeAgo } from '../lib/earnings';
import type { BuilderFeeChange } from '../lib/tenants';
import { IconClose, IconPencil } from './icons';

function changeCount(history: BuilderFeeChange[] | undefined): number {
  return history?.length ?? 0;
}

function changeLabel(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`;
}

/**
 * Current builder fee plus a public change log. Pencil is owner-only
 * (My Projects). History is on every card so traders see the trail.
 */
export function BuilderFeeValue({
  tenths,
  history,
  onEdit,
  compact,
}: {
  tenths: number;
  history?: BuilderFeeChange[];
  onEdit?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const n = changeCount(history);
  return (
    <span className={`inline-flex items-center justify-center gap-1 ${compact ? '' : 'flex-wrap'}`}>
      <span>{formatFeePercent(tenths)}</span>
      {n > 0 ? (
        <button
          type="button"
          className="rounded-md px-1 text-[10px] font-bold text-fg-subtle hover:text-fg"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
        >
          ({changeLabel(n)})
        </button>
      ) : null}
      {onEdit ? (
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
          aria-label="Edit builder fee"
          title="Change builder fee"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit();
          }}
        >
          <IconPencil size={11} />
        </button>
      ) : null}
      {open ? <FeeHistoryDialog history={history ?? []} current={tenths} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

export function BuilderFeeEditDialog({
  tenths,
  history,
  busy,
  error,
  onSave,
  onClose,
}: {
  tenths: number;
  history?: BuilderFeeChange[];
  busy?: boolean;
  error?: string | null;
  onSave: (tenths: number) => void;
  onClose: () => void;
}) {
  const [next, setNext] = useState(tenths);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Overlay onClose={onClose} title="Builder fee">
      <p className="text-[13px] leading-5 text-fg-muted">
        Traders see every change on this app. New orders use the rate you save.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {BUILDER_FEE_CHIPS.map((n) => (
          <button
            key={n}
            type="button"
            className="chip"
            aria-pressed={next === n}
            onClick={() => setNext(n)}
          >
            {formatFeePercent(n)}
          </button>
        ))}
      </div>
      {history && history.length > 0 ? (
        <FeeHistoryList history={history} current={tenths} className="mt-4" />
      ) : null}
      {error ? <p className="mt-3 text-[12px] font-semibold text-error">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={busy || next === tenths}
          onClick={() => onSave(next)}
        >
          {busy ? 'Saving…' : 'Save fee'}
        </button>
      </div>
    </Overlay>
  );
}

function FeeHistoryDialog({
  history,
  current,
  onClose,
}: {
  history: BuilderFeeChange[];
  current: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Overlay onClose={onClose} title="Fee history">
      <p className="text-[13px] leading-5 text-fg-muted">
        Now {formatFeePercent(current)}. New orders use this rate.
      </p>
      <FeeHistoryList history={history} current={current} className="mt-4" />
    </Overlay>
  );
}

function FeeHistoryList({
  history,
  current,
  className,
}: {
  history: BuilderFeeChange[];
  current: number;
  className?: string;
}) {
  const rows = [...history].reverse();
  return (
    <ol className={`grid gap-2 ${className ?? ''}`}>
      <li className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="font-bold text-fg">Now {formatFeePercent(current)}</span>
        <span className="text-fg-subtle">current</span>
      </li>
      {rows.map((row, i) => (
        <li key={`${row.changed_at ?? i}-${row.to_tenths}`} className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="tabular text-fg">
            {formatFeePercent(row.from_tenths)} → {formatFeePercent(row.to_tenths)}
          </span>
          <span className="text-fg-subtle">{row.changed_at ? relativeAgo(row.changed_at) : ''}</span>
        </li>
      ))}
    </ol>
  );
}

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-labelledby="fee-dialog-title"
        className="card-pop w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="fee-dialog-title" className="text-[15px] font-extrabold">
            {title}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
