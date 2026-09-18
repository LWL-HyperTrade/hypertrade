import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPx, formatSz, type L2Book, type TapeTrade } from '../../lib/hlMarket';
import { IconChevron } from '../icons';

const ROW_H = 22;
const SPREAD_H = 34;
/** Pull deeper than we render so tick grouping still has enough buckets. */
const DEPTH = 80;

type Tab = 'book' | 'trades';
type BookUnit = 'coin' | 'usdc';
type BookView = 'both' | 'bids' | 'asks';

type Props = {
  book: L2Book | null;
  mark: number | null;
  trades: TapeTrade[];
  /** Base asset label (e.g. HYPE). */
  sizeUnit?: string;
  /**
   * Chosen tick as HL `nSigFigs` (2–5) or `null` for the exchange's finest
   * levels. The parent feeds it into the `l2Book` subscription so HL groups
   * server-side — 20 aggregated levels instead of 20 raw ones that all round
   * to the same label.
   */
  onSigFigsChange?: (nSigFigs: number | null) => void;
};

/**
 * Tick → HL significant figures for the current price magnitude.
 * ARB 0.1586 @ 0.01 → 2 (0.16, 0.17 …); BTC 75,900 @ 10 → 4; BTC @ 1 → 5.
 * Finer than 5 sig figs (e.g. BTC @ 0.1) → `null`: HL has nothing finer, so
 * take its full-precision levels and let client grouping handle the rest.
 * Coarser than 2 → clamp to 2 and finish the grouping client-side.
 */
function tickToSigFigs(tick: number, mark: number | null): number | null {
  if (!(tick > 0) || mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  const magnitude = Math.floor(Math.log10(mark));
  const tickExp = Math.round(Math.log10(tick));
  const sig = magnitude - tickExp + 1;
  if (sig > 5) return null;
  return Math.max(2, sig);
}

type Level = { px: number; sz: number };

function tickOptions(mark: number | null): number[] {
  const m = mark != null && Number.isFinite(mark) ? Math.abs(mark) : 100;
  if (m >= 1000) return [0.1, 1, 10, 100];
  if (m >= 100) return [0.01, 0.1, 1, 10];
  if (m >= 10) return [0.01, 0.1, 1];
  if (m >= 1) return [0.001, 0.01, 0.1, 1];
  return [0.0001, 0.001, 0.01, 0.1];
}

function formatTick(t: number): string {
  if (t >= 1) return String(t);
  const s = t.toFixed(8).replace(/\.?0+$/, '');
  return s;
}

function formatGroupedPx(px: number, tick: number): string {
  const decimals = Math.max(0, Math.min(8, (String(tick).split('.')[1] || '').length));
  return px.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Bids floor to tick; asks ceil to tick (HL-style grouping). */
function groupLevels(levels: Level[], tick: number, side: 'ask' | 'bid'): Level[] {
  if (!(tick > 0)) return levels;
  const map = new Map<number, number>();
  for (const l of levels) {
    const bucket =
      side === 'bid'
        ? Math.floor(l.px / tick + 1e-12) * tick
        : Math.ceil(l.px / tick - 1e-12) * tick;
    const key = Number(bucket.toFixed(10));
    map.set(key, (map.get(key) ?? 0) + l.sz);
  }
  const out = [...map.entries()].map(([px, sz]) => ({ px, sz }));
  out.sort((a, b) => (side === 'ask' ? a.px - b.px : b.px - a.px));
  return out;
}

export function OrderBook({ book, mark, trades, sizeUnit = '', onSigFigsChange }: Props) {
  const [tab, setTab] = useState<Tab>('book');
  const [view, setView] = useState<BookView>('both');
  const ticks = useMemo(() => tickOptions(mark), [mark]);
  const [tick, setTick] = useState(ticks[0] ?? 0.01);

  // Ask HL for the book at this grouping. Depends on price magnitude, so a
  // coin crossing a power of ten re-derives it; the parent dedupes.
  const sigFigs = tickToSigFigs(tick, mark);
  const onSigFigsRef = useRef(onSigFigsChange);
  onSigFigsRef.current = onSigFigsChange;
  useEffect(() => {
    onSigFigsRef.current?.(sigFigs);
  }, [sigFigs]);
  const [unit, setUnit] = useState<BookUnit>('coin');
  const [tickOpen, setTickOpen] = useState(false);
  const [unitOpen, setUnitOpen] = useState(false);
  const [fitRows, setFitRows] = useState(12);
  const controlsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ticks.includes(tick)) setTick(ticks[0] ?? 0.01);
  }, [ticks, tick]);

  useEffect(() => {
    if (!tickOpen && !unitOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!controlsRef.current?.contains(e.target as Node)) {
        setTickOpen(false);
        setUnitOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [tickOpen, unitOpen]);

  useEffect(() => {
    if (tab !== 'book') return;
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      const forLevels = Math.max(0, h - SPREAD_H);
      if (view === 'both') {
        setFitRows(Math.max(3, Math.floor(forLevels / 2 / ROW_H)));
      } else {
        setFitRows(Math.max(6, Math.floor(forLevels / ROW_H)));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, view]);

  // HL already grouped the feed at `sigFigs`; this pass only finishes the job
  // when the tick is coarser than HL's coarsest (2 sig figs) or finer than its
  // finest (null). Never fall back to raw levels here — labelling ten distinct
  // raw prices with the same rounded tick is exactly the "0.16 × 10" bug.
  const askSrc = groupLevels((book?.asks ?? []).slice(0, DEPTH), tick, 'ask');
  const bidSrc = groupLevels((book?.bids ?? []).slice(0, DEPTH), tick, 'bid');

  const askCount = view === 'bids' ? 0 : fitRows;
  const bidCount = view === 'asks' ? 0 : fitRows;
  const rawAsks = askSrc.slice(0, askCount);
  const rawBids = bidSrc.slice(0, bidCount);
  // Asks render top→bottom as worst→best (best ask sits just above the spread).
  const asks = padLevels([...rawAsks].reverse(), askCount);
  const bids = padLevels(rawBids, bidCount);

  const askCoinTotals = cumulativeFromFar(asks, 'coin');
  const bidCoinTotals = cumulativeFromNear(bids, 'coin');
  const askUsdTotals = cumulativeFromFar(asks, 'usdc');
  const bidUsdTotals = cumulativeFromNear(bids, 'usdc');
  const maxTotal = Math.max(
    1,
    ...(unit === 'usdc' ? [...askUsdTotals, ...bidUsdTotals] : [...askCoinTotals, ...bidCoinTotals]),
  );

  const bestAsk = book?.asks[0]?.px ?? null;
  const bestBid = book?.bids[0]?.px ?? null;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const spreadPct = spread != null && bestBid ? (spread / bestBid) * 100 : null;
  const unitLabel = unit === 'usdc' ? 'USDC' : sizeUnit || 'Asset';

  const spreadBar = (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-y border-stroke-weak bg-surface/80 px-2"
      style={{ height: SPREAD_H }}
    >
      <span className="tabular text-[13px] font-bold text-fg">{formatPx(mark ?? bestAsk ?? bestBid)}</span>
      <span className="tabular text-[10px] text-fg-subtle">
        Spread{' '}
        <span className="text-fg-muted">
          {spread != null ? formatPx(spread) : '—'}
          {spreadPct != null ? ` · ${spreadPct.toFixed(3)}%` : ''}
        </span>
      </span>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="grid shrink-0 grid-cols-2 border-b border-stroke-weak">
        {(
          [
            ['book', 'Order Book'],
            ['trades', 'Trades'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`relative py-2.5 text-center text-[12px] font-bold ${
              tab === id ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {label}
            {tab === id ? <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-brand" /> : null}
          </button>
        ))}
      </div>

      {tab === 'book' ? (
        <>
          <div ref={controlsRef} className="relative flex shrink-0 items-center justify-between gap-2 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5" role="group" aria-label="Order book view">
                {(
                  [
                    ['both', 'Bids and asks'],
                    ['bids', 'Bids only'],
                    ['asks', 'Asks only'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-pressed={view === id}
                    onClick={() => setView(id)}
                    className={`rounded p-1 ${
                      view === id ? 'bg-fill-hover text-fg' : 'text-fg-subtle hover:bg-fill-weak hover:text-fg'
                    }`}
                  >
                    <BookViewIcon mode={id} />
                  </button>
                ))}
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setTickOpen((o) => !o);
                    setUnitOpen(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-fg-muted hover:bg-fill-weak hover:text-fg"
                >
                  {formatTick(tick)}
                  <IconChevron size={12} className={`transition-transform ${tickOpen ? 'rotate-180' : ''}`} />
                </button>
                {tickOpen ? (
                  <div className="absolute left-0 top-full z-20 mt-1 min-w-[4.5rem] overflow-hidden rounded-md border border-stroke-weak bg-overlay py-1 shadow-lg">
                    {ticks.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setTick(t);
                          setTickOpen(false);
                        }}
                        className={`block w-full px-3 py-1.5 text-left text-[11px] font-bold tabular ${
                          t === tick ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                        }`}
                      >
                        {formatTick(t)}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setUnitOpen((o) => !o);
                  setTickOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-fg-muted hover:bg-fill-weak hover:text-fg"
              >
                {unitLabel}
                <IconChevron size={12} className={`transition-transform ${unitOpen ? 'rotate-180' : ''}`} />
              </button>
              {unitOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 min-w-[5rem] overflow-hidden rounded-md border border-stroke-weak bg-overlay py-1 shadow-lg">
                  {(
                    [
                      ['coin', sizeUnit || 'Asset'],
                      ['usdc', 'USDC'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setUnit(id);
                        setUnitOpen(false);
                      }}
                      className={`block w-full px-3 py-1.5 text-left text-[11px] font-bold ${
                        unit === id ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-3 px-2 py-1 text-[10px] text-fg-subtle">
            <span>Price</span>
            <span className="text-right">Size ({unitLabel})</span>
            <span className="text-right">Total ({unitLabel})</span>
          </div>

          <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {view !== 'bids' ? (
              <div className="flex shrink-0 flex-col justify-end" style={{ height: askCount * ROW_H }}>
                {asks.map((l, i) => (
                  <BookRow
                    key={`a-${i}-${l?.px ?? 'empty'}`}
                    level={l}
                    total={unit === 'usdc' ? askUsdTotals[i] ?? 0 : askCoinTotals[i] ?? 0}
                    maxTotal={maxTotal}
                    side="ask"
                    tick={tick}
                    unit={unit}
                  />
                ))}
              </div>
            ) : null}

            {spreadBar}

            {view !== 'asks' ? (
              <div className="flex shrink-0 flex-col" style={{ height: bidCount * ROW_H }}>
                {bids.map((l, i) => (
                  <BookRow
                    key={`b-${i}-${l?.px ?? 'empty'}`}
                    level={l}
                    total={unit === 'usdc' ? bidUsdTotals[i] ?? 0 : bidCoinTotals[i] ?? 0}
                    maxTotal={maxTotal}
                    side="bid"
                    tick={tick}
                    unit={unit}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <TradeList trades={trades} />
      )}
    </div>
  );
}

function BookViewIcon({ mode }: { mode: BookView }) {
  const line = 'var(--text-subtle, #6b7280)';
  const up = 'var(--market-up, #22c55e)';
  const down = 'var(--market-down, #ef4444)';
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden className="block">
      {mode === 'both' ? (
        <>
          <rect x="1" y="1" width="3.5" height="5.5" rx="0.5" fill={down} />
          <rect x="1" y="7.5" width="3.5" height="5.5" rx="0.5" fill={up} />
          <rect x="6.5" y="2" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="6.3" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="10.6" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
        </>
      ) : mode === 'bids' ? (
        <>
          <rect x="1" y="1" width="3.5" height="12" rx="0.5" fill={up} />
          <rect x="6.5" y="2" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="6.3" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="10.6" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
        </>
      ) : (
        <>
          <rect x="1" y="1" width="3.5" height="12" rx="0.5" fill={down} />
          <rect x="6.5" y="2" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="6.3" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
          <rect x="6.5" y="10.6" width="8.5" height="1.4" rx="0.4" fill={line} opacity="0.55" />
        </>
      )}
    </svg>
  );
}

function padLevels(levels: Level[], n: number): Array<Level | null> {
  const out: Array<Level | null> = levels.slice(0, n);
  while (out.length < n) out.push(null);
  return out;
}

function cumulativeFromFar(levels: Array<Level | null>, mode: BookUnit): number[] {
  const fromMid: number[] = new Array(levels.length).fill(0);
  let run = 0;
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const l = levels[i];
    run += l ? (mode === 'usdc' ? l.sz * l.px : l.sz) : 0;
    fromMid[i] = run;
  }
  return fromMid;
}

function cumulativeFromNear(levels: Array<Level | null>, mode: BookUnit): number[] {
  const totals: number[] = [];
  let run = 0;
  for (let i = 0; i < levels.length; i += 1) {
    const l = levels[i];
    run += l ? (mode === 'usdc' ? l.sz * l.px : l.sz) : 0;
    totals.push(run);
  }
  return totals;
}

function displayAmt(value: number, px: number, unit: BookUnit, isTotal: boolean): string {
  if (unit === 'usdc') {
    const ntl = isTotal ? value : value * px;
    return ntl >= 1000
      ? ntl.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : ntl.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return formatSz(value);
}

function BookRow({
  level,
  total,
  maxTotal,
  side,
  tick,
  unit,
}: {
  level: Level | null;
  total: number;
  maxTotal: number;
  side: 'ask' | 'bid';
  tick: number;
  unit: BookUnit;
}) {
  if (!level) {
    return <div style={{ height: ROW_H }} aria-hidden />;
  }
  const width = `${Math.min(100, (total / maxTotal) * 100)}%`;
  return (
    <div
      className="relative grid grid-cols-3 px-2 text-[11px] hover:bg-fill-weaker/50"
      style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}
    >
      <div
        className={`absolute inset-y-0 right-0 ${side === 'ask' ? 'depth-ask' : 'depth-bid'}`}
        style={{ width }}
      />
      <span className={`relative tabular font-medium ${side === 'ask' ? 'text-market-down' : 'text-market-up'}`}>
        {formatGroupedPx(level.px, tick)}
      </span>
      <span className="relative tabular text-right text-fg">{displayAmt(level.sz, level.px, unit, false)}</span>
      <span className="relative tabular text-right text-fg-muted">{displayAmt(total, level.px, unit, true)}</span>
    </div>
  );
}

function TradeList({ trades }: { trades: TapeTrade[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-3 px-2 py-1 text-[10px] text-fg-subtle">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-fg-subtle">Waiting for prints…</p>
        ) : (
          trades.map((t) => (
            <div
              key={t.key}
              className={`grid h-[22px] grid-cols-3 px-2 text-[11px] leading-[22px] ${
                t.side === 'B' ? 'tape-buy' : 'tape-sell'
              }`}
            >
              <span className={`tabular font-medium ${t.side === 'B' ? 'text-market-up' : 'text-market-down'}`}>
                {formatPx(t.px)}
              </span>
              <span className="tabular text-right text-fg">{formatSz(t.sz)}</span>
              <span className="tabular text-right text-fg-subtle">{clock(t.time)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
