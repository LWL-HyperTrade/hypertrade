import { useEffect, useState, type ReactNode } from 'react';
import { clampPledgePct, formatPledgePercent, keepPct, PLEDGE_CHIPS, relativeAgo } from '../lib/earnings';
import type { PledgeChange } from '../lib/tenants';
import { IconClose, IconPencil } from './icons';

function changeCount(history: PledgeChange[] | undefined): number {
  return history?.length ?? 0;
}

function changeLabel(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`;
}

export function PledgeValue({
  label,
  pct,
  history,
  compact,
  hideLabel,
  onEdit,
}: {
  label: string;
  pct: number;
  history?: PledgeChange[];
  compact?: boolean;
  hideLabel?: boolean;
  onEdit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const n = changeCount(history);
  return (
    <span className={`inline-flex items-center justify-center gap-1 ${compact ? '' : 'flex-wrap'}`}>
      <span>
        {hideLabel ? null : <span className="mr-1 text-fg-subtle">{label}</span>}
        {formatPledgePercent(pct)}
      </span>
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
          aria-label={`Edit ${label.toLowerCase()}`}
          title={`Change ${label.toLowerCase()}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit();
          }}
        >
          <IconPencil size={11} />
        </button>
      ) : null}
      {open ? (
        <PledgeHistoryDialog
          title={`${label} history`}
          history={history ?? []}
          current={pct}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

export function PledgePairValue({
  buyback,
  burn,
  buybackHistory,
  burnHistory,
  onEditBuyback,
  onEditBurn,
  compact,
}: {
  buyback: number;
  burn: number;
  buybackHistory?: PledgeChange[];
  burnHistory?: PledgeChange[];
  onEditBuyback?: () => void;
  onEditBurn?: () => void;
  compact?: boolean;
}) {
  return (
    <span className={`inline-flex items-center justify-center gap-2 ${compact ? '' : 'flex-wrap'}`}>
      <PledgeValue
        label="Buybacks"
        pct={buyback}
        history={buybackHistory}
        compact={compact}
        onEdit={onEditBuyback}
      />
      <PledgeValue label="Burn" pct={burn} history={burnHistory} compact={compact} onEdit={onEditBurn} />
    </span>
  );
}

export function PledgeEditDialog({
  kind,
  pct,
  history,
  buybackPct,
  busy,
  error,
  onSave,
  onClose,
}: {
  kind: 'buyback' | 'burn';
  pct: number;
  history?: PledgeChange[];
  /** Current buyback % — shown as context when editing burn. */
  buybackPct?: number;
  busy?: boolean;
  error?: string | null;
  onSave: (pct: number) => void;
  onClose: () => void;
}) {
  const [next, setNext] = useState(() => clampPledgePct(pct));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isBurn = kind === 'burn';
  const buyback = clampPledgePct(buybackPct ?? 0);
  const keep = keepPct(isBurn ? buyback : next);

  return (
    <Overlay onClose={onClose} title={isBurn ? 'Burn' : 'Buybacks'}>
      <p className="text-[13px] leading-5 text-fg-muted">
        {isBurn
          ? 'Of the tokens you buy back, this share you pledge to burn. Example: 70% buybacks then 50% burn means half of that buyback is burned.'
          : 'Share of your builder fee you pledge to buy back. You keep the rest as cash. Burn is a separate percent of this buyback.'}
        {' '}
        Not on-chain — traders have to trust you, and they see every change.
      </p>
      <PledgeChipRow
        label={isBurn ? 'Burn' : 'Buybacks'}
        hint={isBurn ? 'of that buyback' : 'of your fee'}
        value={next}
        onPick={setNext}
      />
      {isBurn ? (
        <p className="mt-3 text-[12px] font-semibold text-fg">
          Buybacks stay {formatPledgePercent(buyback)} of your fee. Of that, {formatPledgePercent(next)} burned.
        </p>
      ) : (
        <p className="mt-3 text-[12px] font-semibold text-fg">
          You keep {formatPledgePercent(keep)} of your fee.
        </p>
      )}
      {history && history.length > 0 ? (
        <PledgeHistoryList history={history} current={pct} className="mt-4" />
      ) : null}
      {error ? <p className="mt-3 text-[12px] font-semibold text-error">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm"
          disabled={busy || next === clampPledgePct(pct)}
          onClick={() => onSave(next)}
        >
          {busy ? 'Saving…' : isBurn ? 'Save burn' : 'Save buybacks'}
        </button>
      </div>
    </Overlay>
  );
}

export function PledgeChipRow({
  label,
  value,
  onPick,
  hint,
  align = 'start',
}: {
  label: string;
  value: number;
  onPick: (n: number) => void;
  hint?: string;
  align?: 'start' | 'end';
}) {
  return (
    <div className={align === 'end' ? 'mt-3' : 'mt-4'}>
      <div className={`label mb-2 ${align === 'end' ? 'lg:justify-end' : ''}`}>
        <span className="req">{label}</span>
        <span className="text-[10px] font-semibold text-fg-subtle">{hint ?? 'of your fee'}</span>
      </div>
      <div className={`flex flex-wrap gap-2 ${align === 'end' ? 'lg:justify-end' : ''}`}>
        {PLEDGE_CHIPS.map((n) => (
          <button key={n} type="button" className="chip" aria-pressed={value === n} onClick={() => onPick(n)}>
            {formatPledgePercent(n)}
          </button>
        ))}
      </div>
    </div>
  );
}

function PledgeHistoryDialog({
  title,
  history,
  current,
  onClose,
}: {
  title: string;
  history: PledgeChange[];
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
    <Overlay onClose={onClose} title={title}>
      <p className="text-[13px] leading-5 text-fg-muted">
        Now {formatPledgePercent(current)}. This is a promise, not on-chain.
      </p>
      <PledgeHistoryList history={history} current={current} className="mt-4" />
    </Overlay>
  );
}

function PledgeHistoryList({
  history,
  current,
  label,
  className,
}: {
  history: PledgeChange[];
  current: number;
  label?: string;
  className?: string;
}) {
  const rows = [...history].reverse();
  return (
    <ol className={`grid gap-2 ${className ?? ''}`}>
      <li className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="font-bold text-fg">
          {label ? `${label} · ` : ''}Now {formatPledgePercent(current)}
        </span>
        <span className="text-fg-subtle">current</span>
      </li>
      {rows.map((row, i) => (
        <li key={`${row.changed_at ?? i}-${row.to_pct}`} className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="tabular text-fg">
            {formatPledgePercent(row.from_pct)} → {formatPledgePercent(row.to_pct)}
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
        aria-labelledby="pledge-dialog-title"
        className="card-pop w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="pledge-dialog-title" className="text-[15px] font-extrabold">
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
