/**
 * Opening reasoning + hourly checks for a resident.
 * `page` is the short block on the creator landing.
 * `dock` is the full list in the terminal tab.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchTenantResident } from '../../lib/api';
import { useWebAuth } from '../../lib/auth';
import { fetchOpenOrders, formatPx, formatUsd, type OpenOrder } from '../../lib/hlMarket';
import { cancelUserOrder, marketCloseUserPosition, placeUserPositionTpsl } from '../../lib/hlTrade/placeOrder';
import { PositionTpslSheet, type PositionTpslTarget } from '../terminal/PositionTpslSheet';
import { ensureResidentBuilderApproved, resolveApprovedResidentBuilder } from '../../lib/hlTrade/resident';
import { isWalletUserRejectedRequest } from '../../lib/hlTrade/wallet';
import type { Hex } from '../../lib/hlTrade/constants';
import { shortAddr } from '../../lib/tenants';
import type { ResidentAgentSlice, ResidentDecision, ResidentOpening, TenantResidentPayload } from '../../lib/residents';
import { IconCheck, IconCopy } from '../icons';

export function ResidentWalletLine({
  address,
  compact = false,
  className = '',
}: {
  address: string;
  compact?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <span className={className}>
      <span className="break-all font-mono text-[12px] font-bold leading-5 text-fg">
        {compact ? shortAddr(address) : address}
      </span>
      <button
        type="button"
        className="ml-1 inline-flex h-5 w-5 align-middle items-center justify-center rounded text-fg-subtle hover:bg-fill-hover hover:text-fg"
        aria-label={copied ? 'Copied' : 'Copy address'}
        onClick={() => void copy()}
      >
        {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
      </button>
    </span>
  );
}

function when(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function market(symbol: string | undefined): string {
  const raw = String(symbol || '');
  return (raw.includes(':') ? raw.split(':').pop() : raw) || '';
}

function residentOrderFromHl(o: OpenOrder): Record<string, unknown> {
  const kind = o.tpsl === 'tp' ? 'take_profit' : o.tpsl === 'sl' ? 'stop' : 'limit';
  return {
    symbol: o.coin,
    side: o.side === 'B' ? 'LONG' : 'SHORT',
    kind,
    triggerPx: o.triggerPx,
    size: o.sz > 0 ? o.sz : null,
    reduceOnly: o.reduceOnly || o.tpsl != null,
    oid: o.oid,
  };
}

function sameMarket(a: string, b: string): boolean {
  const left = market(a).toUpperCase();
  const right = market(b).toUpperCase();
  return !!left && left === right;
}

/** Drop a just-closed position or cancelled order before the next resident fetch lands. */
function withoutClosed(
  data: TenantResidentPayload | undefined,
  symbols: string[],
  oids: number[],
): TenantResidentPayload | undefined {
  if (!data) return data;
  return {
    ...data,
    agents: data.agents.map((agent) => ({
      ...agent,
      positions: (agent.positions ?? []).filter(
        (p) => !symbols.some((s) => sameMarket(s, String((p as { symbol?: string }).symbol || ''))),
      ),
      openOrders: ((agent as { openOrders?: Array<Record<string, unknown>> }).openOrders ?? []).filter(
        (o) => !oids.includes(Number(o.oid)),
      ),
    })),
  };
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function pnlClass(n: number): string {
  if (n > 0) return 'text-success';
  if (n < 0) return 'text-error';
  return 'text-fg-muted';
}

function sideClass(side: string | null | undefined): string {
  if (side === 'LONG') return 'text-success';
  if (side === 'SHORT') return 'text-error';
  return '';
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-fg-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] font-bold tabular text-fg">{value}</div>
    </div>
  );
}

function OpeningBlock({ opening }: { opening: ResidentOpening }) {
  const summary = (opening.summary || '').trim();
  const reasoning = (opening.reasoning || '').trim();
  const detail = reasoning && reasoning !== summary ? reasoning : '';
  const facts: Array<{ label: string; value: string }> = [];
  if (opening.sizeUsd != null) facts.push({ label: 'Size', value: formatUsd(opening.sizeUsd) });
  if (opening.leverage != null) facts.push({ label: 'Leverage', value: `${opening.leverage}x` });
  if (opening.entryPrice != null) facts.push({ label: 'Entry', value: formatPx(opening.entryPrice) });
  if (opening.stopPrice != null) facts.push({ label: 'Stop', value: formatPx(opening.stopPrice) });
  if (opening.takeProfit != null) facts.push({ label: 'Target', value: formatPx(opening.takeProfit) });
  return (
    <div>
      <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">Opening</div>
      <p className="mt-1 text-[13px] font-semibold leading-5 text-fg">
        <span className={sideClass(opening.side)}>{opening.side || 'Opened'}</span>
        {market(opening.symbol) ? <span className="text-fg-subtle"> · {market(opening.symbol)}</span> : null}
        {opening.conviction != null ? (
          <span className="text-fg-subtle"> · conviction {opening.conviction}</span>
        ) : null}
      </p>
      {facts.length ? (
        <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
          {facts.map((f) => (
            <Fact key={f.label} label={f.label} value={f.value} />
          ))}
        </div>
      ) : null}
      {summary ? <p className="mt-2 text-[13px] leading-5 text-fg">{summary}</p> : null}
      {detail ? <p className="mt-1.5 text-[12px] leading-5 text-fg-muted">{detail}</p> : null}
    </div>
  );
}

function RowConfirm({
  label,
  busyLabel,
  confirm,
  busy,
  onAsk,
  onConfirm,
  onBack,
}: {
  label: string;
  busyLabel: string;
  confirm: boolean;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  if (confirm) {
    return (
      <span className="inline-flex shrink-0 gap-1 text-[11px]">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="font-semibold text-market-down hover:underline disabled:opacity-40"
        >
          {busy ? busyLabel : 'Confirm'}
        </button>
        <button type="button" className="text-fg-subtle hover:underline" onClick={onBack}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onAsk}
      className="shrink-0 text-[11px] font-semibold text-brand hover:underline disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function BulkTextAction({
  label,
  bulkLabel,
  busyLabel,
  show,
  confirming,
  busy,
  onAsk,
  onConfirm,
  onBack,
}: {
  label: string;
  bulkLabel: string;
  busyLabel: string;
  show: boolean;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  if (show && confirming) {
    return (
      <span className="inline-flex items-center justify-end gap-1.5 text-[11px]">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="font-semibold text-market-down hover:underline disabled:opacity-40"
        >
          {busy ? busyLabel : 'Confirm'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className="text-fg-subtle hover:underline disabled:opacity-40"
        >
          Back
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1.5 text-[11px] text-fg-subtle">
      {show ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onAsk}
            className="font-semibold text-brand hover:underline disabled:opacity-40"
          >
            {busy ? busyLabel : bulkLabel}
          </button>
          <span className="text-fg-subtle/50" aria-hidden>
            |
          </span>
        </>
      ) : null}
      {label}
    </span>
  );
}

function PositionList({
  positions,
  title,
  onClose,
  onCloseAll,
  onOpenTpsl,
  closingSymbol,
  closingAll,
  confirmClose,
}: {
  positions: Array<Record<string, unknown>>;
  title?: string;
  onClose?: (position: Record<string, unknown>) => void;
  onCloseAll?: (positions: Array<Record<string, unknown>>) => void;
  onOpenTpsl?: (position: Record<string, unknown>) => void;
  closingSymbol?: string | null;
  closingAll?: boolean;
  confirmClose?: boolean;
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  if (!positions.length) return null;
  const closable = positions.filter((p) => Number.isFinite(Number(p.szi)) && Number(p.szi) !== 0);
  const showAll = !!onClose && !!onCloseAll && closable.length > 1;
  return (
    <div className={title ? 'mb-4' : ''}>
      {title || showAll ? (
        <div className="flex items-center justify-between gap-3">
          {title ? (
            <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{title}</div>
          ) : (
            <span />
          )}
          {showAll ? (
            <BulkTextAction
              label="Close"
              bulkLabel="Close all"
              busyLabel="Closing…"
              show
              confirming={confirmAll}
              busy={!!closingAll}
              onAsk={() => {
                setConfirmKey(null);
                setConfirmAll(true);
              }}
              onConfirm={() => {
                setConfirmAll(false);
                onCloseAll?.(closable);
              }}
              onBack={() => setConfirmAll(false)}
            />
          ) : null}
        </div>
      ) : null}
      <ul className="mt-1">
        {positions.map((p, i) => {
          const sym = market(String(p.symbol || ''));
          const pnl = Number(p.unrealizedPnl);
          const pnlOk = Number.isFinite(pnl);
          const roe = Number(p.unrealizedPct);
          const roeOk = Number.isFinite(roe);
          const side = String(p.side || '');
          const lev = Number(p.leverage);
          const entry = Number(p.entry);
          const mark = Number(p.mark);
          const size = Number(p.sizeUsd);
          const liqRaw = Number(p.liquidationPx);
          const liq = Number.isFinite(liqRaw) && liqRaw > 0 ? liqRaw : null;
          const margin = Number(p.marginUsed);
          const funding = Number(p.fundingUsd);
          const facts: Array<{ label: string; value: string }> = [];
          if (Number.isFinite(size)) facts.push({ label: 'Size', value: formatUsd(size) });
          if (Number.isFinite(entry)) facts.push({ label: 'Entry', value: formatPx(entry) });
          if (Number.isFinite(mark)) facts.push({ label: 'Mark', value: formatPx(mark) });
          facts.push({
            label: 'Liq',
            value: liq != null && Number.isFinite(liq) && liq > 0 ? formatPx(liq) : '—',
          });
          if (Number.isFinite(margin)) facts.push({ label: 'Margin', value: formatUsd(margin) });
          if (Number.isFinite(funding)) facts.push({ label: 'Funding', value: formatUsd(funding) });
          const key = `${sym}-${i}`;
          const canClose = !!onClose && Number.isFinite(Number(p.szi)) && Number(p.szi) !== 0;
          const busy = !!closingAll || closingSymbol === sym;
          const confirm = !!confirmClose && confirmKey === key;
          return (
            <li
              key={key}
              aria-busy={busy || undefined}
              className={`border-t border-stroke-weak py-2.5 transition-opacity first:border-t-0 ${
                busy ? 'pointer-events-none opacity-40' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px]">
                  <span className="font-semibold text-fg">{sym || '—'}</span>
                  {side ? <span className={`font-semibold ${sideClass(side)}`}>{side}</span> : null}
                  {Number.isFinite(lev) ? (
                    <span className="font-bold text-fg-subtle">
                      · {lev}x{p.marginType ? ` ${String(p.marginType)}` : ''}
                    </span>
                  ) : null}
                  {pnlOk || roeOk ? (
                    <span className={`font-mono font-bold tabular ${pnlOk ? pnlClass(pnl) : pnlClass(roe)}`}>
                      {pnlOk ? formatUsd(pnl) : ''}
                      {pnlOk && roeOk ? ' · ' : ''}
                      {roeOk ? fmtPct(roe) : ''}
                    </span>
                  ) : null}
                  {p.manual ? (
                    <span className="ml-0.5 inline-flex items-center rounded-md border border-stroke-strong bg-fill-weak px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-fg-subtle">
                      Manual
                    </span>
                  ) : null}
                </div>
                {canClose ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    {!confirm && onOpenTpsl && Number.isFinite(entry) && entry > 0 && Number.isFinite(mark) && mark > 0 ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onOpenTpsl(p)}
                          className="text-[11px] font-semibold text-market-up hover:underline disabled:opacity-40"
                        >
                          TP/SL
                        </button>
                        <span className="text-fg-subtle/50" aria-hidden>
                          |
                        </span>
                      </>
                    ) : null}
                  <RowConfirm
                    label="Close"
                    busyLabel="Closing…"
                    confirm={confirm}
                    busy={busy}
                    onAsk={() => {
                      setConfirmAll(false);
                      if (!confirmClose) {
                        onClose?.(p);
                        return;
                      }
                      setConfirmKey(key);
                    }}
                    onConfirm={() => {
                      setConfirmKey(null);
                      onClose?.(p);
                    }}
                    onBack={() => setConfirmKey(null)}
                  />
                  </span>
                ) : null}
              </div>
              {facts.length ? (
                <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
                  {facts.map((f) => (
                    <Fact key={f.label} label={f.label} value={f.value} />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function orderKindLabel(kind: string): string {
  if (kind === 'take_profit') return 'Take profit';
  if (kind === 'stop') return 'Stop';
  if (kind === 'limit') return 'Limit';
  return kind.replace(/_/g, ' ');
}

function OrderRow({
  order,
  onCancel,
  cancelling,
  cancellingAll,
  confirm,
  onAsk,
  onBack,
}: {
  order: Record<string, unknown>;
  onCancel?: (order: Record<string, unknown>) => void;
  cancelling?: boolean;
  cancellingAll?: boolean;
  confirm?: boolean;
  onAsk?: () => void;
  onBack?: () => void;
}) {
  const kind = String(order.kind || 'order');
  const side = String(order.side || '');
  const trigger = Number(order.triggerPx);
  const size = Number(order.size);
  const hasSize = Number.isFinite(size) && size > 0;
  const closes = Boolean(order.reduceOnly) || kind === 'stop' || kind === 'take_profit';
  const canCancel = !!onCancel && Number.isFinite(Number(order.oid)) && Number(order.oid) > 0;
  const busy = !!cancellingAll || !!cancelling;
  return (
    <li
      aria-busy={busy || undefined}
      className={`border-t border-stroke-weak py-2.5 transition-opacity first:border-t-0 ${
        busy ? 'pointer-events-none opacity-40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 text-[13px]">
            <span className="font-semibold text-fg">{market(String(order.symbol || '')) || '—'}</span>
            <span className="font-bold text-fg-subtle">{orderKindLabel(kind)}</span>
            {side ? <span className={sideClass(side)}>{side}</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-muted">
            {Number.isFinite(trigger) && trigger > 0 ? (
              <span>
                Trigger <span className="font-mono font-bold tabular text-fg">{formatPx(trigger)}</span>
              </span>
            ) : null}
            <span>{hasSize ? `Size ${size}` : closes ? 'Closes the position' : '—'}</span>
          </div>
        </div>
        {canCancel ? (
          <RowConfirm
            label="Cancel"
            busyLabel="Cancelling…"
            confirm={!!confirm}
            busy={busy}
            onAsk={() => onAsk?.()}
            onConfirm={() => onCancel?.(order)}
            onBack={() => onBack?.()}
          />
        ) : null}
      </div>
    </li>
  );
}

const DECISION_PAGE = 8;

function DecisionList({ rows }: { rows: ResidentDecision[] }) {
  const [shown, setShown] = useState(DECISION_PAGE);
  const visible = rows.slice(0, shown);
  const left = rows.length - visible.length;
  return (
    <div className="mt-1">
      {visible.map((row, i) => (
        <DecisionRow key={row.id || `${row.at}-${i}`} row={row} />
      ))}
      {left > 0 ? (
        <button
          type="button"
          onClick={() => setShown((n) => n + DECISION_PAGE)}
          className="mt-2 text-[12px] font-extrabold text-fg-muted hover:text-fg"
        >
          Show more ({left})
        </button>
      ) : null}
    </div>
  );
}

function DecisionRow({ row }: { row: ResidentDecision }) {
  const summary = (row.body || '').trim();
  const reasoning = (row.reasoning || '').trim();
  const detail = reasoning && reasoning !== summary ? reasoning : '';
  const pnl = row.pnlPct;
  const pnlOk = pnl != null && Number.isFinite(pnl);
  return (
    <details className="group border-t border-stroke-weak py-2 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-baseline gap-2">
        <span className="text-[13px] font-semibold text-fg">
          {row.headline || 'Check'}
          {row.direction ? <span className={sideClass(row.direction)}> {row.direction}</span> : null}
          {market(row.symbol) ? <span className="font-bold text-fg-subtle"> · {market(row.symbol)}</span> : null}
          {pnlOk ? <span className={`font-mono font-bold tabular ${pnlClass(pnl)}`}> · {fmtPct(pnl)}</span> : null}
        </span>
        <span className="text-[11px] text-fg-subtle">{when(row.at)}</span>
      </summary>
      {summary ? <p className="mt-1.5 text-[13px] leading-5 text-fg">{summary}</p> : null}
      {detail ? <p className="mt-1 text-[12px] leading-5 text-fg-muted">{detail}</p> : null}
    </details>
  );
}

export function ResidentDecisions({
  agents,
  variant,
}: {
  agents: ResidentAgentSlice[];
  variant: 'page' | 'dock';
}) {
  const rows = agents.flatMap((a) => a.decisions ?? []);
  const positions = agents.flatMap((a) =>
    (a.positions ?? []).map(
      (p) => ({ ...(p as Record<string, unknown>), accountValue: a.accountValue }) as Record<string, unknown>,
    ),
  );
  const opening = agents.map((a) => a.opening).find((o) => o && (o.side || o.summary || o.reasoning)) ?? null;
  if (!opening && !rows.length && !positions.length) {
    return (
      <p className="text-[12px] leading-5 text-fg-subtle">
        No decisions yet. The first one runs on the hour after the agent is live.
      </p>
    );
  }
  const checks = rows.length ? (
    variant === 'page' ? (
      <details className={`group ${positions.length ? 'mt-3' : ''}`}>
        <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl border border-line bg-fill-weak px-3.5 py-2.5 hover:bg-fill-strong">
          <span className="text-[14px] font-extrabold text-fg">Recent decisions</span>
          <span className="rounded-full bg-[#5b9cff]/15 px-2 py-0.5 font-mono text-[12px] font-black tabular text-[#5b9cff]">
            {rows.length}
          </span>
          <span className="ml-auto text-[12px] leading-none text-fg-subtle transition group-open:rotate-180">▾</span>
        </summary>
        <DecisionList rows={rows} />
      </details>
    ) : (
      <div className={opening ? 'mt-4' : ''}>
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
          Recent decisions ({rows.length})
        </div>
        <DecisionList rows={rows} />
      </div>
    )
  ) : null;
  const checksFirst = variant === 'page' && positions.length === 0;
  return (
    <div className="min-w-0">
      {checksFirst ? checks : null}
      {variant === 'page' ? <PositionList positions={positions} title="Live position" /> : null}
      {opening ? <OpeningBlock opening={opening} /> : null}
      {checksFirst ? null : checks}
    </div>
  );
}

/** Terminal tab: the resident's own book. Balances live on the Portfolio tab. */
export function ResidentDecisionsDock({
  slug,
  canManage = false,
  feeTenths = 0,
  builderAddress = null,
  cloidPrefix = 'bp',
  confirmClose = true,
}: {
  slug: string;
  /** App owner can close the resident book and cancel its orders. */
  canManage?: boolean;
  feeTenths?: number;
  builderAddress?: string | null;
  cloidPrefix?: string;
  /** When false, Close skips the Confirm step. Same preference as the positions table. */
  confirmClose?: boolean;
}) {
  const q = useQuery({
    queryKey: ['tenant-resident', slug],
    queryFn: () => fetchTenantResident(slug),
    refetchInterval: 30_000,
  });
  const qc = useQueryClient();
  const { getResidentEthereumProvider, builderAddress: loginBuilder } = useWebAuth();
  const agents = q.data?.agents ?? [];
  const wallet = agents.find((a) => a.wallet)?.wallet ?? null;
  const liveOrdersQ = useQuery({
    queryKey: ['hl', 'openOrders', wallet],
    enabled: !!wallet,
    queryFn: () => fetchOpenOrders(String(wallet)),
    refetchInterval: 8_000,
  });
  /** Symbols/oids HL has accepted but the resident payload may still list. */
  const [hiddenSymbols, setHiddenSymbols] = useState<string[]>([]);
  const [hiddenOids, setHiddenOids] = useState<number[]>([]);
  const positions = agents
    .flatMap((a) =>
      (a.positions ?? []).map(
        (p) => ({ ...(p as Record<string, unknown>), accountValue: a.accountValue }) as Record<string, unknown>,
      ),
    )
    .filter((p) => !hiddenSymbols.some((s) => sameMarket(s, String(p.symbol || ''))));
  const payloadOrders = agents.flatMap(
    (a) => ((a.openOrders as Array<Record<string, unknown>> | undefined) ?? []).map((o) => o),
  );
  const orders = (liveOrdersQ.data ? liveOrdersQ.data.map(residentOrderFromHl) : payloadOrders).filter(
    (o) => !hiddenOids.includes(Number(o.oid)),
  );

  useEffect(() => {
    if (!hiddenSymbols.length && !hiddenOids.length) return;
    const timer = window.setTimeout(() => {
      setHiddenSymbols([]);
      setHiddenOids([]);
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [hiddenSymbols, hiddenOids]);

  const settleClosed = (symbols: string[], oids: number[]) => {
    if (symbols.length) {
      setHiddenSymbols((cur) => [...cur, ...symbols.filter((s) => !cur.some((c) => sameMarket(c, s)))]);
    }
    if (oids.length) {
      setHiddenOids((cur) => [...cur, ...oids.filter((n) => !cur.includes(n))]);
    }
    qc.setQueryData<TenantResidentPayload>(['tenant-resident', slug], (old) => withoutClosed(old, symbols, oids));
    void (async () => {
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 700));
        const fresh = await qc.fetchQuery({
          queryKey: ['tenant-resident', slug],
          queryFn: () => fetchTenantResident(slug),
          staleTime: 0,
        });
        const stillSymbols = symbols.filter((s) =>
          (fresh.agents ?? []).some((a) =>
            (a.positions ?? []).some((p) => sameMarket(s, String((p as { symbol?: string }).symbol || ''))),
          ),
        );
        const stillOids = oids.filter((oid) =>
          (fresh.agents ?? []).some((a) =>
            ((a as { openOrders?: Array<Record<string, unknown>> }).openOrders ?? []).some((o) => Number(o.oid) === oid),
          ),
        );
        setHiddenSymbols((cur) =>
          cur.filter((s) => {
            const tracked = symbols.some((k) => sameMarket(k, s));
            if (!tracked) return true;
            return stillSymbols.some((k) => sameMarket(k, s));
          }),
        );
        setHiddenOids((cur) => cur.filter((n) => !oids.includes(n) || stillOids.includes(n)));
        if (!stillSymbols.length && !stillOids.length) break;
      }
    })();
  };
  const decisions = agents.reduce((n, a) => n + (a.decisions?.length ?? 0), 0);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [cancellingOid, setCancellingOid] = useState<number | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [confirmOid, setConfirmOid] = useState<number | null>(null);
  const [confirmCancelAll, setConfirmCancelAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tpslTarget, setTpslTarget] = useState<PositionTpslTarget | null>(null);
  const [tpslBusy, setTpslBusy] = useState(false);
  const [tpslError, setTpslError] = useState<string | null>(null);

  const residentProvider = async () => {
    if (!wallet) throw new Error('Resident wallet is not ready.');
    const provider = await getResidentEthereumProvider(String(wallet));
    if (!provider) throw new Error('Sign in as the app owner to manage this resident.');
    return provider;
  };

  const openTpsl = (position: Record<string, unknown>) => {
    const symbol = String(position.symbol || '');
    const szi = Number(position.szi);
    const entry = Number(position.entry);
    const markPx = Number(position.mark);
    if (!symbol || !Number.isFinite(szi) || szi === 0 || !(entry > 0) || !(markPx > 0)) return;
    const related = orders.filter((o) => sameMarket(String(o.symbol || ''), symbol));
    const tp = related.find((o) => o.kind === 'take_profit');
    const sl = related.find((o) => o.kind === 'stop');
    const tpPx = Number(tp?.triggerPx);
    const slPx = Number(sl?.triggerPx);
    setTpslError(null);
    setTpslTarget({
      coin: symbol,
      entrySide: szi > 0 ? 'long' : 'short',
      entryPx: entry,
      markPx,
      sizeUnits: Math.abs(szi),
      existingTp: Number.isFinite(tpPx) && tpPx > 0 ? tpPx : null,
      existingSl: Number.isFinite(slPx) && slPx > 0 ? slPx : null,
    });
  };

  const submitTpsl = async (tp: number | null, sl: number | null) => {
    if (!tpslTarget) return;
    const { entrySide, entryPx, coin } = tpslTarget;
    if (tp != null) {
      if (entrySide === 'long' && tp <= entryPx) {
        setTpslError('Take profit must be above entry for a long.');
        return;
      }
      if (entrySide === 'short' && tp >= entryPx) {
        setTpslError('Take profit must be below entry for a short.');
        return;
      }
    }
    if (sl != null) {
      if (entrySide === 'long' && sl >= entryPx) {
        setTpslError('Stop loss must be below entry for a long.');
        return;
      }
      if (entrySide === 'short' && sl <= entryPx) {
        setTpslError('Stop loss must be above entry for a short.');
        return;
      }
    }
    setTpslBusy(true);
    setTpslError(null);
    try {
      const provider = await residentProvider();
      const userAddress = String(wallet) as Hex;
      const feeBuilder = await resolveApprovedResidentBuilder({
        tenantBuilder: builderAddress,
        user: userAddress,
        requiredFeeTenths: feeTenths,
        ownBuilder: loginBuilder,
      });
      await ensureResidentBuilderApproved({
        provider,
        residentAddress: userAddress,
        builderAddress: feeBuilder,
        requiredFeeTenths: feeTenths,
      });
      const existing = orders.filter(
        (o) =>
          sameMarket(String(o.symbol || ''), coin) &&
          (o.kind === 'take_profit' || o.kind === 'stop') &&
          Number(o.oid) > 0,
      );
      const cancelled: number[] = [];
      for (const order of existing) {
        try {
          await cancelUserOrder({
            provider,
            userAddress,
            symbol: String(order.symbol || coin),
            oid: Number(order.oid),
          });
          cancelled.push(Number(order.oid));
        } catch {
          /* replace is best-effort */
        }
      }
      await placeUserPositionTpsl({
        provider,
        userAddress,
        symbol: coin,
        entrySide,
        tpTriggerPx: tp,
        slTriggerPx: sl,
        feeTenths,
        builderAddress: feeBuilder,
      });
      if (cancelled.length) settleClosed([], cancelled);
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', userAddress] });
      void qc.invalidateQueries({ queryKey: ['tenant-resident', slug] });
      setTpslTarget(null);
    } catch (e) {
      setTpslError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'TP/SL failed',
      );
    } finally {
      setTpslBusy(false);
    }
  };

  const closePosition = async (position: Record<string, unknown>) => {
    const symbol = String(position.symbol || '');
    const szi = Number(position.szi);
    if (!symbol || !Number.isFinite(szi) || szi === 0) return;
    setActionError(null);
    setClosingSymbol(market(symbol) || symbol);
    try {
      const provider = await residentProvider();
      const userAddress = String(wallet) as Hex;
      const feeBuilder = await resolveApprovedResidentBuilder({
        tenantBuilder: builderAddress,
        user: userAddress,
        requiredFeeTenths: feeTenths,
        ownBuilder: loginBuilder,
      });
      await ensureResidentBuilderApproved({
        provider,
        residentAddress: userAddress,
        builderAddress: feeBuilder,
        requiredFeeTenths: feeTenths,
      });
      await marketCloseUserPosition({
        provider,
        userAddress,
        symbol,
        szi,
        oraclePx: Number(position.mark) || undefined,
        feeTenths,
        cloidPrefix,
        builderAddress: feeBuilder,
      });
      settleClosed([symbol], []);
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Close failed',
      );
    } finally {
      setClosingSymbol(null);
    }
  };

  const closeAll = async (rows: Array<Record<string, unknown>>) => {
    if (rows.length < 2) return;
    setActionError(null);
    setClosingAll(true);
    try {
      const provider = await residentProvider();
      const userAddress = String(wallet) as Hex;
      const feeBuilder = await resolveApprovedResidentBuilder({
        tenantBuilder: builderAddress,
        user: userAddress,
        requiredFeeTenths: feeTenths,
        ownBuilder: loginBuilder,
      });
      await ensureResidentBuilderApproved({
        provider,
        residentAddress: userAddress,
        builderAddress: feeBuilder,
        requiredFeeTenths: feeTenths,
      });
      for (let i = 0; i < rows.length; i += 1) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        const position = rows[i];
        const symbol = String(position?.symbol || '');
        const szi = Number(position?.szi);
        if (!symbol || !Number.isFinite(szi) || szi === 0) continue;
        await marketCloseUserPosition({
          provider,
          userAddress,
          symbol,
          szi,
          oraclePx: Number(position?.mark) || undefined,
          feeTenths,
          cloidPrefix,
          builderAddress: feeBuilder,
        });
      }
      settleClosed(
        rows.map((p) => String(p?.symbol || '')).filter((s) => !!s),
        [],
      );
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Close failed',
      );
    } finally {
      setClosingAll(false);
    }
  };

  const cancelOrder = async (order: Record<string, unknown>) => {
    const oid = Number(order.oid);
    const symbol = String(order.symbol || '');
    if (!symbol || !Number.isFinite(oid) || oid <= 0) return;
    setActionError(null);
    setCancellingOid(oid);
    try {
      const provider = await residentProvider();
      await cancelUserOrder({
        provider,
        userAddress: String(wallet) as Hex,
        symbol,
        oid,
      });
      settleClosed([], [oid]);
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Cancel failed',
      );
    } finally {
      setCancellingOid(null);
    }
  };

  const cancelAll = async (rows: Array<Record<string, unknown>>) => {
    const live = rows.filter((o) => Number.isFinite(Number(o.oid)) && Number(o.oid) > 0);
    if (live.length < 2) return;
    setActionError(null);
    setCancellingAll(true);
    try {
      const provider = await residentProvider();
      const userAddress = String(wallet) as Hex;
      for (let i = 0; i < live.length; i += 1) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200));
        const order = live[i];
        await cancelUserOrder({
          provider,
          userAddress,
          symbol: String(order?.symbol || ''),
          oid: Number(order?.oid),
        });
      }
      settleClosed(
        [],
        live.map((o) => Number(o.oid)).filter((n) => Number.isFinite(n) && n > 0),
      );
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Cancel failed',
      );
    } finally {
      setCancellingAll(false);
    }
  };

  type Sub = 'position' | 'orders' | 'decisions';
  const [sub, setSub] = useState<Sub>('position');
  const subs: { id: Sub; label: string }[] = [
    { id: 'position', label: `Position${positions.length ? ` (${positions.length})` : ''}` },
    { id: 'orders', label: `Orders${orders.length ? ` (${orders.length})` : ''}` },
    { id: 'decisions', label: `Decisions${decisions ? ` (${decisions})` : ''}` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-stroke-weak px-2">
        {subs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSub(id)}
            className={`shrink-0 px-2.5 py-2 text-[11px] font-bold ${
              sub === id
                ? 'border-b-2 border-[#5b9cff] text-fg'
                : 'border-b-2 border-transparent text-fg-subtle hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-auto px-4 py-3">
        {q.isLoading ? (
          <p className="text-[12px] text-fg-subtle">Loading the resident book…</p>
        ) : q.isError ? (
          <p className="text-[12px] font-semibold text-error">Could not load the resident.</p>
        ) : sub === 'position' ? (
          positions.length ? (
            <PositionList
              positions={positions}
              onClose={canManage ? (p) => void closePosition(p) : undefined}
              onCloseAll={canManage ? (rows) => void closeAll(rows) : undefined}
              onOpenTpsl={canManage ? openTpsl : undefined}
              closingSymbol={closingSymbol}
              closingAll={closingAll}
              confirmClose={confirmClose}
            />
          ) : (
            <p className="text-[12px] text-fg-subtle">No live position.</p>
          )
        ) : sub === 'orders' ? (
          orders.length ? (
            <div>
              {canManage && orders.filter((o) => Number(o.oid) > 0).length > 1 ? (
                <div className="flex justify-end pb-1">
                  <BulkTextAction
                    label="Cancel"
                    bulkLabel="Cancel all"
                    busyLabel="Cancelling…"
                    show
                    confirming={confirmCancelAll}
                    busy={cancellingAll}
                    onAsk={() => {
                      setConfirmOid(null);
                      setConfirmCancelAll(true);
                    }}
                    onConfirm={() => {
                      setConfirmCancelAll(false);
                      void cancelAll(orders);
                    }}
                    onBack={() => setConfirmCancelAll(false)}
                  />
                </div>
              ) : null}
              <ul>
                {orders.map((o, i) => (
                  <OrderRow
                    key={`${String(o.symbol)}-${String(o.kind)}-${i}`}
                    order={o}
                    onCancel={canManage ? (order) => void cancelOrder(order) : undefined}
                    cancelling={cancellingOid != null && cancellingOid === Number(o.oid)}
                    cancellingAll={cancellingAll}
                    confirm={confirmOid != null && confirmOid === Number(o.oid)}
                    onAsk={() => {
                      setConfirmCancelAll(false);
                      setConfirmOid(Number(o.oid));
                    }}
                    onBack={() => setConfirmOid(null)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[12px] text-fg-subtle">No open orders.</p>
          )
        ) : (
          <ResidentDecisions agents={agents} variant="dock" />
        )}
        {actionError ? <p className="mt-2 text-[11px] font-semibold text-error">{actionError}</p> : null}
      </div>
      <PositionTpslSheet
        target={tpslTarget}
        busy={tpslBusy}
        error={tpslError}
        onClose={() => {
          if (!tpslBusy) setTpslTarget(null);
        }}
        onSubmit={(tp, sl) => void submitTpsl(tp, sl)}
      />
    </div>
  );
}
