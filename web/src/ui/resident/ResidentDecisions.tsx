/**
 * Opening reasoning + hourly checks for a resident.
 * `page` is the short block on the creator landing.
 * `dock` is the full list in the terminal tab.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchTenantResident } from '../../lib/api';
import { useWebAuth } from '../../lib/auth';
import { formatPx, formatUsd } from '../../lib/hlMarket';
import { cancelUserOrder, marketCloseUserPosition } from '../../lib/hlTrade/placeOrder';
import { isWalletUserRejectedRequest } from '../../lib/hlTrade/wallet';
import type { Hex } from '../../lib/hlTrade/constants';
import { shortAddr } from '../../lib/tenants';
import type { ResidentAgentSlice, ResidentDecision, ResidentOpening } from '../../lib/residents';
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

function PositionList({
  positions,
  title,
  onClose,
  closingSymbol,
}: {
  positions: Array<Record<string, unknown>>;
  title?: string;
  onClose?: (position: Record<string, unknown>) => void;
  closingSymbol?: string | null;
}) {
  if (!positions.length) return null;
  return (
    <div className={title ? 'mb-4' : ''}>
      {title ? (
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{title}</div>
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
          const liq = Number(p.liquidationPx);
          const margin = Number(p.marginUsed);
          const funding = Number(p.fundingUsd);
          const facts: Array<{ label: string; value: string }> = [];
          if (Number.isFinite(size)) facts.push({ label: 'Size', value: formatUsd(size) });
          if (Number.isFinite(entry)) facts.push({ label: 'Entry', value: formatPx(entry) });
          if (Number.isFinite(mark)) facts.push({ label: 'Mark', value: formatPx(mark) });
          if (Number.isFinite(liq) && liq > 0) facts.push({ label: 'Liq', value: formatPx(liq) });
          if (Number.isFinite(margin)) facts.push({ label: 'Margin', value: formatUsd(margin) });
          if (Number.isFinite(funding)) facts.push({ label: 'Funding', value: formatUsd(funding) });
          return (
            <li key={`${sym}-${i}`} className="border-t border-stroke-weak py-2.5 first:border-t-0">
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
                  {p.manual ? <span className="text-fg-subtle">· Manual</span> : null}
                </div>
                {onClose && Number.isFinite(Number(p.szi)) && Number(p.szi) !== 0 ? (
                  <ConfirmButton
                    label="Close"
                    busy={closingSymbol === sym}
                    onConfirm={() => onClose(p)}
                  />
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

function ConfirmButton({
  label,
  busy,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        onConfirm();
      }}
      className="shrink-0 rounded-md border border-stroke-strong px-2 py-1 text-[11px] font-bold text-fg hover:bg-fill-hover disabled:opacity-50"
    >
      {busy ? '…' : armed ? 'Confirm' : label}
    </button>
  );
}

function OrderRow({
  order,
  onCancel,
  cancelling,
}: {
  order: Record<string, unknown>;
  onCancel?: (order: Record<string, unknown>) => void;
  cancelling?: boolean;
}) {
  const kind = String(order.kind || 'order');
  const side = String(order.side || '');
  const trigger = Number(order.triggerPx);
  const size = Number(order.size);
  const hasSize = Number.isFinite(size) && size > 0;
  const closes = Boolean(order.reduceOnly) || kind === 'stop' || kind === 'take_profit';
  return (
    <li className="border-t border-stroke-weak py-2.5 first:border-t-0">
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
        {onCancel && Number.isFinite(Number(order.oid)) && Number(order.oid) > 0 ? (
          <ConfirmButton label="Cancel" busy={!!cancelling} onConfirm={() => onCancel(order)} />
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
  const positions = agents.flatMap((a) => (a.positions ?? []).map((p) => p as Record<string, unknown>));
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

/** Terminal tab: the resident's own book, split so position, orders, balance,
 *  and the decision log are not one stacked scroll. */
export function ResidentDecisionsDock({
  slug,
  canManage = false,
  feeTenths = 0,
  builderAddress = null,
  cloidPrefix = 'bp',
}: {
  slug: string;
  /** App owner can close the resident book and cancel its orders. */
  canManage?: boolean;
  feeTenths?: number;
  builderAddress?: string | null;
  cloidPrefix?: string;
}) {
  const q = useQuery({
    queryKey: ['tenant-resident', slug],
    queryFn: () => fetchTenantResident(slug),
    refetchInterval: 30_000,
  });
  const qc = useQueryClient();
  const { getResidentEthereumProvider } = useWebAuth();
  const agents = q.data?.agents ?? [];
  const positions = agents.flatMap((a) =>
    (a.positions ?? []).map((p) => p as Record<string, unknown>),
  );
  const orders = agents.flatMap((a) =>
    ((a.openOrders as Array<Record<string, unknown>> | undefined) ?? []).map((o) => o),
  );
  const decisions = agents.reduce((n, a) => n + (a.decisions?.length ?? 0), 0);
  const account = agents.reduce((s, a) => s + (Number(a.accountValue) || 0), 0);
  const available = agents.reduce((s, a) => s + (Number(a.withdrawable) || 0), 0);
  const hasBalance = agents.some((a) => a.accountValue != null || a.withdrawable != null);
  const wallet = agents.find((a) => a.wallet)?.wallet;
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [cancellingOid, setCancellingOid] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const residentProvider = async () => {
    if (!wallet) throw new Error('Resident wallet is not ready.');
    const provider = await getResidentEthereumProvider(String(wallet));
    if (!provider) throw new Error('Sign in as the app owner to manage this resident.');
    return provider;
  };

  const closePosition = async (position: Record<string, unknown>) => {
    const symbol = String(position.symbol || '');
    const szi = Number(position.szi);
    if (!symbol || !Number.isFinite(szi) || szi === 0) return;
    setActionError(null);
    setClosingSymbol(market(symbol) || symbol);
    try {
      const provider = await residentProvider();
      await marketCloseUserPosition({
        provider,
        userAddress: String(wallet) as Hex,
        symbol,
        szi,
        oraclePx: Number(position.mark) || undefined,
        feeTenths,
        cloidPrefix,
        builderAddress,
      });
      void qc.invalidateQueries({ queryKey: ['tenant-resident', slug] });
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Close failed',
      );
    } finally {
      setClosingSymbol(null);
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
      void qc.invalidateQueries({ queryKey: ['tenant-resident', slug] });
    } catch (e) {
      setActionError(
        isWalletUserRejectedRequest(e) ? 'Wallet request was rejected.' : e instanceof Error ? e.message : 'Cancel failed',
      );
    } finally {
      setCancellingOid(null);
    }
  };

  type Sub = 'position' | 'orders' | 'balance' | 'decisions';
  const [sub, setSub] = useState<Sub>('position');
  const subs: { id: Sub; label: string }[] = [
    { id: 'position', label: `Position${positions.length ? ` (${positions.length})` : ''}` },
    { id: 'orders', label: `Orders${orders.length ? ` (${orders.length})` : ''}` },
    { id: 'balance', label: 'Balance' },
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
              closingSymbol={closingSymbol}
            />
          ) : (
            <p className="text-[12px] text-fg-subtle">No live position.</p>
          )
        ) : sub === 'orders' ? (
          orders.length ? (
            <ul>
              {orders.map((o, i) => (
                <OrderRow
                  key={`${String(o.symbol)}-${String(o.kind)}-${i}`}
                  order={o}
                  onCancel={canManage ? (order) => void cancelOrder(order) : undefined}
                  cancelling={cancellingOid != null && cancellingOid === Number(o.oid)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-fg-subtle">No open orders.</p>
          )
        ) : sub === 'balance' ? (
          <div className="grid grid-cols-3 gap-x-4 gap-y-3 text-[12px]">
            <div>
              <div className="text-fg-subtle">Account value</div>
              <div className="mt-0.5 font-mono text-[15px] font-black tabular text-fg">
                {hasBalance ? formatUsd(account) : '—'}
              </div>
            </div>
            <div>
              <div className="text-fg-subtle">Available</div>
              <div className="mt-0.5 font-mono text-[15px] font-black tabular text-fg">
                {hasBalance ? formatUsd(available) : '—'}
              </div>
            </div>
            <div>
              <div className="text-fg-subtle">Wallet</div>
              <div className="mt-0.5">
                {wallet ? <ResidentWalletLine address={String(wallet)} compact /> : <span className="text-fg-subtle">—</span>}
              </div>
            </div>
          </div>
        ) : (
          <ResidentDecisions agents={agents} variant="dock" />
        )}
        {actionError ? <p className="mt-2 text-[11px] font-semibold text-error">{actionError}</p> : null}
      </div>
    </div>
  );
}
