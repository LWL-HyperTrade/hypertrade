import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dispose, init, type Chart, type KLineData, type Period } from 'klinecharts';
import type { Candle, CandleInterval } from '../../lib/hlMarket';
import { formatPx } from '../../lib/hlMarket';
import { applyChartDisplay, applyIndicatorPrefs, ensureKlineAverages } from '../../lib/klineIndicators';
import {
  barSource,
  emaSeries,
  enabledAverageRows,
  loadIndicatorPrefs,
  saveIndicatorPrefs,
  smaSeries,
  type MaBandRow,
  type WebIndicatorPrefs,
} from '../../lib/indicatorPrefs';
import {
  getLegendCollapsed,
  saveLegendCollapsed,
  type ChartMode,
} from '../../lib/chartPrefs';
import { IconChevron, IconEye, IconEyeOff, IconFib, IconFx, IconHorizLine, IconTrash, IconTrendLine } from '../icons';
import type { ChartPriceLine } from '../../lib/chartLines';
import { syncKlinePriceLines } from '../../lib/klineLines';
import { ChartWatermark, type ChartWatermarkBrand } from './ChartWatermark';
import { IndicatorSheet } from './IndicatorSheet';

const UP = '#77c7af';
const DOWN = '#ff9c9c';
const NEON = '#4ef2bb';
/** Crosshair — muted grey so it doesn't fight green entry / TP lines. */
const CROSSHAIR = '#ffffff66';
const GRID = '#ffffff14';
const AXIS = '#ffffff99';
const FONT = '"Basel Grotesk", Basel, Inter, ui-sans-serif, system-ui, sans-serif';

type DrawTool = 'segment' | 'horizontalStraightLine' | 'fibonacciLine';

function toBar(c: Candle): KLineData {
  return { timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v };
}

function toPeriod(interval: CandleInterval): Period {
  switch (interval) {
    case '1m':
      return { span: 1, type: 'minute' };
    case '3m':
      return { span: 3, type: 'minute' };
    case '5m':
      return { span: 5, type: 'minute' };
    case '15m':
      return { span: 15, type: 'minute' };
    case '30m':
      return { span: 30, type: 'minute' };
    case '1h':
      return { span: 1, type: 'hour' };
    case '2h':
      return { span: 2, type: 'hour' };
    case '4h':
      return { span: 4, type: 'hour' };
    case '8h':
      return { span: 8, type: 'hour' };
    case '12h':
      return { span: 12, type: 'hour' };
    case '1d':
      return { span: 1, type: 'day' };
    case '3d':
      return { span: 3, type: 'day' };
    case '1w':
      return { span: 1, type: 'week' };
    case '1M':
      return { span: 1, type: 'month' };
  }
}

/** Hide the vertical rule beside price labels on narrow panes; keep the x-axis baseline. */
function applyYAxisEdge(chart: Chart, compact: boolean) {
  chart.setStyles({
    yAxis: {
      axisLine: { show: !compact, color: compact ? 'transparent' : '#ffffff1f', size: compact ? 0 : 1 },
    },
  });
}

/** Same density as mobile `barSpacing: 8` so long MA/EMA warmup stays off-screen. */
const DEFAULT_BAR_SPACE = 8;
/** Keep last candles left of the price-line tags (~"Buy 12,345.00" width). */
const RIGHT_OFFSET_PX = 124;

function applyDefaultViewport(chart: Chart) {
  chart.setBarSpace(DEFAULT_BAR_SPACE);
  chart.setOffsetRightDistance(RIGHT_OFFSET_PX);
  chart.scrollToRealTime(0);
}

const TOOLS: { id: DrawTool; title: string; Icon: (p: { size?: number }) => ReactNode }[] = [
  { id: 'segment', title: 'Trend line', Icon: IconTrendLine },
  { id: 'horizontalStraightLine', title: 'Horizontal line', Icon: IconHorizLine },
  { id: 'fibonacciLine', title: 'Fib retracement', Icon: IconFib },
];

function candleLegendCount(prefs: WebIndicatorPrefs): number {
  let n = 0;
  n += enabledAverageRows(prefs.maRows).length;
  n += enabledAverageRows(prefs.emaRows).length;
  if (prefs.boll) n += 3;
  if (prefs.vwap) n += 1;
  return n;
}

function lastBand(kind: 'sma' | 'ema', rows: MaBandRow[], candles: Candle[]): Array<number | undefined> {
  return rows.map((row) => {
    const prices = candles.map((c) => barSource({ open: c.o, high: c.h, low: c.l, close: c.c }, row.source));
    const series = kind === 'ema' ? emaSeries(prices, row.period) : smaSeries(prices, row.period);
    return series[series.length - 1];
  });
}

function lastVwap(candles: Candle[], period: number): number | undefined {
  if (!candles.length) return undefined;
  const i = candles.length - 1;
  const from = Math.max(0, i - Math.max(2, period) + 1);
  let pv = 0;
  let vol = 0;
  for (let j = from; j <= i; j++) {
    const d = candles[j];
    pv += ((d.h + d.l + d.c) / 3) * d.v;
    vol += d.v;
  }
  return vol > 0 ? pv / vol : undefined;
}

function lastBoll(candles: Candle[], length: number, mult: number): { up: number; mid: number; dn: number } | undefined {
  const n = Math.max(2, length);
  const closes = candles.map((c) => c.c);
  const midSeries = smaSeries(closes, n);
  const i = closes.length - 1;
  const mid = midSeries[i];
  if (mid == null) return undefined;
  const from = i - n + 1;
  let sumSq = 0;
  for (let j = from; j <= i; j++) {
    const d = closes[j] - mid;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / n);
  return { up: mid + mult * std, mid, dn: mid - mult * std };
}

export default function KLineChartPane({
  candles,
  interval,
  symbol,
  fxSlot,
  timezone,
  chartMode,
  showHighLow,
  showOhlcv,
  watermark,
  lines,
  showLines,
}: {
  candles: Candle[];
  interval: CandleInterval;
  symbol: string;
  fxSlot?: HTMLElement | null;
  timezone: string;
  chartMode: ChartMode;
  showHighLow: boolean;
  showOhlcv: boolean;
  watermark?: ChartWatermarkBrand | null;
  /** Entry / liq / TP-SL / limit lines for this symbol. */
  lines?: ChartPriceLine[];
  showLines?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const candlesRef = useRef(candles);
  const pushRef = useRef<((bar: KLineData) => void) | null>(null);
  const histRef = useRef({ first: 0, len: 0, ready: false });
  const lastPushRef = useRef<Candle | null>(null);
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [legendCollapsed, setLegendCollapsed] = useState(() => getLegendCollapsed());
  const [prefs, setPrefs] = useState<WebIndicatorPrefs>(() => loadIndicatorPrefs());
  const prefsRef = useRef(prefs);
  const legendRef = useRef(legendCollapsed);
  prefsRef.current = prefs;
  legendRef.current = legendCollapsed;
  candlesRef.current = candles;

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const sync = () => setLegendCollapsed(getLegendCollapsed(mq.matches));
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    ensureKlineAverages();
    const chart = init(host, {
      locale: 'en-US',
      timezone,
      styles: {
        grid: {
          horizontal: { color: GRID, dashedValue: [3, 3] },
          vertical: { color: GRID, dashedValue: [3, 3] },
        },
        candle: {
          bar: {
            upColor: UP,
            downColor: DOWN,
            upBorderColor: UP,
            downBorderColor: DOWN,
            upWickColor: UP,
            downWickColor: DOWN,
            noChangeColor: '#888888',
          },
          priceMark: {
            last: {
              upColor: UP,
              downColor: DOWN,
              text: { size: 11, family: FONT, color: '#0a0a0a' },
            },
            high: { color: AXIS, textFamily: FONT },
            low: { color: AXIS, textFamily: FONT },
          },
          tooltip: {
            offsetLeft: 28,
            offsetTop: 6,
            legend: {
              color: AXIS,
              family: FONT,
              size: 11,
              marginTop: 2,
              marginBottom: 2,
              template: [
                { title: 'O: ', value: '{open}' },
                { title: 'H: ', value: '{high}' },
                { title: 'L: ', value: '{low}' },
                { title: 'C: ', value: '{close}' },
                { title: 'V: ', value: '{volume}' },
              ],
            },
            // Symbol/period already in the terminal chrome — keep one OHLCV row.
            title: { show: false, color: AXIS, family: FONT, size: 11 },
          },
        },
        indicator: {
          tooltip: {
            showRule: 'none',
            offsetLeft: 28,
            title: { color: AXIS, family: FONT, size: 11 },
            legend: { color: AXIS, family: FONT, size: 11 },
          },
          lines: [
            { color: NEON },
            { color: '#27d821' },
            { color: '#5eead4' },
            { color: '#e0be70' },
            { color: '#c084fc' },
          ],
        },
        xAxis: {
          axisLine: { color: '#ffffff1f' },
          tickLine: { color: '#ffffff1f' },
          tickText: { color: AXIS, family: FONT, size: 11 },
        },
        yAxis: {
          size: 64,
          axisLine: { show: true, color: '#ffffff1f' },
          tickLine: { color: '#ffffff1f' },
          tickText: { color: AXIS, family: FONT, size: 11 },
        },
        separator: { color: '#ffffff1f' },
        crosshair: {
          horizontal: {
            line: { color: CROSSHAIR },
            text: { backgroundColor: '#3a3b44', color: '#fff', family: FONT, size: 11 },
          },
          vertical: {
            line: { color: CROSSHAIR },
            text: { backgroundColor: '#3a3b44', color: '#fff', family: FONT, size: 11 },
          },
        },
        overlay: {
          line: { color: NEON, size: 1 },
          point: { color: NEON, borderColor: '#4ef2bb55', activeColor: NEON },
          text: { backgroundColor: NEON, color: '#0a0a0a', family: FONT },
        },
      },
    });
    if (!chart) return;
    chartRef.current = chart;

    chart.setSymbol({ ticker: symbol || 'PERP', pricePrecision: 4, volumePrecision: 2 });
    chart.setPeriod(toPeriod(interval));
    chart.setDataLoader({
      getBars: ({ callback }) => {
        const bars = candlesRef.current;
        callback(bars.length < 2 ? [] : bars.map(toBar));
      },
      subscribeBar: ({ callback }) => {
        pushRef.current = callback;
      },
      unsubscribeBar: () => {
        pushRef.current = null;
      },
    });
    applyIndicatorPrefs(chart, prefsRef.current, legendRef.current, showOhlcv);
    applyChartDisplay(chart, { mode: chartMode, showHighLow, showOhlcv, legendCollapsed: legendRef.current });
    applyYAxisEdge(chart, host.clientWidth < 640);
    applyDefaultViewport(chart);

    let lastW = host.clientWidth;
    let lastH = host.clientHeight;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      applyYAxisEdge(chart, w < 640);
      chart.resize();
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      pushRef.current = null;
      dispose(chart);
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setTimezone(timezone);
  }, [timezone]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setSymbol({ ticker: symbol || 'PERP', pricePrecision: 4, volumePrecision: 2 });
    chart.setPeriod(toPeriod(interval));
    histRef.current = { first: 0, len: 0, ready: false };
    lastPushRef.current = null;
    if (candlesRef.current.length >= 2) {
      chart.resetData();
      applyDefaultViewport(chart);
    }
  }, [symbol, interval]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length < 2) {
      if (!candles.length) {
        histRef.current = { first: 0, len: 0, ready: false };
        lastPushRef.current = null;
      }
      return;
    }
    const first = candles[0].t;
    const last = candles[candles.length - 1];
    const h = histRef.current;
    if (!h.ready || first !== h.first || candles.length < h.len) {
      histRef.current = { first, len: candles.length, ready: true };
      lastPushRef.current = last;
      chart.resetData();
      applyDefaultViewport(chart);
      return;
    }
    histRef.current = { first, len: candles.length, ready: true };
    const prev = lastPushRef.current;
    if (
      prev &&
      prev.t === last.t &&
      prev.o === last.o &&
      prev.h === last.h &&
      prev.l === last.l &&
      prev.c === last.c &&
      prev.v === last.v
    ) {
      return;
    }
    lastPushRef.current = last;
    pushRef.current?.(toBar(last));
  }, [candles]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyIndicatorPrefs(chart, prefs, legendRef.current, showOhlcv);
    applyChartDisplay(chart, { mode: chartMode, showHighLow, showOhlcv, legendCollapsed: legendRef.current });
  }, [prefs, chartMode, showHighLow, showOhlcv]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    applyIndicatorPrefs(chart, prefsRef.current, legendCollapsed, showOhlcv);
    applyChartDisplay(chart, { mode: chartMode, showHighLow, showOhlcv, legendCollapsed });
  }, [legendCollapsed, chartMode, showHighLow, showOhlcv]);

  // Position / order lines. Tag stacking happens inside the overlay's
  // `createPointFigures`, which klinecharts re-runs with fresh coordinates on
  // every paint (zoom / pan included) — no re-sync subscription needed.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    syncKlinePriceLines(chart, showLines === false ? [] : (lines ?? []));
  }, [lines, showLines, symbol, interval]);

  const startDraw = (next: DrawTool) => {
    const chart = chartRef.current;
    if (!chart) return;
    setTool(next);
    chart.createOverlay(next);
  };

  const clearDrawings = () => {
    const chart = chartRef.current;
    // Only user drawings — position / order lines are not "drawings".
    for (const t of TOOLS) chart?.removeOverlay({ name: t.id });
    setTool(null);
  };

  const patchPrefs = (next: WebIndicatorPrefs) => {
    setPrefs(next);
    saveIndicatorPrefs(next);
  };

  const maRows = enabledAverageRows(prefs.maRows);
  const emaRows = enabledAverageRows(prefs.emaRows);
  const overlayCount = candleLegendCount(prefs);
  const maLast = useMemo(() => lastBand('sma', maRows, candles), [maRows, candles]);
  const emaLast = useMemo(() => lastBand('ema', emaRows, candles), [emaRows, candles]);
  const vwapLast = useMemo(
    () => (prefs.vwap ? lastVwap(candles, prefs.vwapLength || 14) : undefined),
    [candles, prefs.vwap, prefs.vwapLength],
  );
  const bollLast = useMemo(
    () => (prefs.boll ? lastBoll(candles, prefs.bollLength || 20, prefs.bollMult || 2) : undefined),
    [candles, prefs.boll, prefs.bollLength, prefs.bollMult],
  );

  const fxUi = fxSlot
    ? createPortal(
        <button
          type="button"
          title="Indicators"
          onClick={() => setFxOpen((o) => !o)}
          className={`inline-flex h-7 items-center justify-center gap-1 rounded-[2px] px-1 leading-none ${
            fxOpen ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
          }`}
        >
          <IconFx size={16} className="block" />
          <span className="hidden text-[12px] font-semibold leading-none sm:inline">Indicators</span>
        </button>,
        fxSlot,
      )
    : null;

  return (
    <div className="relative min-h-0 flex-1">
      {fxUi}
      <IndicatorSheet open={fxOpen} prefs={prefs} onChange={patchPrefs} onClose={() => setFxOpen(false)} />
      <div
        ref={hostRef}
        className={`absolute inset-0 bg-background transition-opacity duration-300 ${
          candles.length < 2 ? 'opacity-25' : 'opacity-100'
        }`}
      />
      {candles.length < 2 ? (
        <div className="pointer-events-none absolute inset-0 z-[2] bg-background/35" aria-busy />
      ) : null}
      {candles.length >= 2 ? <ChartWatermark brand={watermark} /> : null}
      <button
        type="button"
        title={legendCollapsed ? 'Show overlay values' : 'Hide overlay values'}
        aria-expanded={!legendCollapsed}
        onClick={() => {
          setLegendCollapsed((c) => {
            const next = !c;
            saveLegendCollapsed(next);
            return next;
          });
        }}
        className="absolute left-1.5 top-1.5 z-20 inline-flex items-center gap-0.5 rounded px-0.5 text-fg-subtle hover:text-fg"
      >
        <IconChevron size={12} className={legendCollapsed ? '' : 'rotate-180'} />
        {legendCollapsed && overlayCount > 0 ? (
          <span className="text-[11px] font-medium tabular-nums">{overlayCount}</span>
        ) : null}
      </button>
      {!legendCollapsed ? (
        <div
          className="pointer-events-none absolute left-7 z-20 flex max-w-[calc(100%-4.5rem)] flex-col gap-0.5 text-[11px] font-medium"
          style={{ top: showOhlcv ? 28 : 6 }}
        >
          {maRows.length ? (
            <OverlayLegendRow
              visible={prefs.maVisible}
              onToggle={() => patchPrefs({ ...prefs, maVisible: !prefs.maVisible })}
              items={maRows.map((row, i) => ({
                label: `MA${row.period}`,
                value: maLast[i],
                color: row.color,
              }))}
            />
          ) : null}
          {emaRows.length ? (
            <OverlayLegendRow
              visible={prefs.emaVisible}
              onToggle={() => patchPrefs({ ...prefs, emaVisible: !prefs.emaVisible })}
              items={emaRows.map((row, i) => ({
                label: `EMA${row.period}`,
                value: emaLast[i],
                color: row.color,
              }))}
            />
          ) : null}
          {prefs.vwap ? (
            <OverlayLegendRow
              visible={prefs.vwapVisible !== false}
              onToggle={() => patchPrefs({ ...prefs, vwapVisible: prefs.vwapVisible === false })}
              items={[{ label: `VWAP${prefs.vwapLength || 14}`, value: vwapLast, color: prefs.vwapColor }]}
            />
          ) : null}
          {prefs.boll ? (
            <OverlayLegendRow
              visible={prefs.bollVisible !== false}
              onToggle={() => patchPrefs({ ...prefs, bollVisible: prefs.bollVisible === false })}
              items={[
                { label: 'BOLL', value: bollLast?.mid, color: prefs.bollColors[1] },
                { label: 'UP', value: bollLast?.up, color: prefs.bollColors[0] },
                { label: 'DN', value: bollLast?.dn, color: prefs.bollColors[2] },
              ]}
            />
          ) : null}
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center">
        <div className="pointer-events-auto flex items-center">
          {railOpen ? (
            <div className="ml-1 rounded-md border border-stroke-weak bg-background/90 py-1 shadow-lg backdrop-blur-sm">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.title}
                  onClick={() => startDraw(t.id)}
                  className={`flex h-8 w-8 items-center justify-center ${
                    tool === t.id ? 'text-brand' : 'text-fg-subtle hover:text-fg'
                  }`}
                >
                  <t.Icon size={20} />
                </button>
              ))}
              <button
                type="button"
                title="Remove drawings"
                onClick={clearDrawings}
                className="flex h-8 w-8 items-center justify-center text-fg-subtle hover:text-fg"
              >
                <IconTrash size={20} />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            aria-label={railOpen ? 'Hide drawing tools' : 'Show drawing tools'}
            onClick={() => setRailOpen((o) => !o)}
            className="flex h-8 w-4 items-center justify-center rounded-r border border-l-0 border-stroke-weak bg-background/80 text-fg-subtle hover:text-fg"
          >
            <IconChevron size={12} className={railOpen ? 'rotate-90' : '-rotate-90'} />
          </button>
        </div>
      </div>
    </div>
  );
}

function OverlayLegendRow({
  visible,
  onToggle,
  items,
}: {
  visible: boolean;
  onToggle: () => void;
  items: { label: string; value: number | undefined; color: string }[];
}) {
  const Eye = visible ? IconEye : IconEyeOff;
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${visible ? '' : 'opacity-45'}`}>
      <div className="min-w-0 truncate">
        {items.map((item, i) => (
          <span key={`${item.label}-${i}`} className="mr-2 tabular-nums" style={{ color: item.color }}>
            {item.label}: {formatPx(item.value)}
          </span>
        ))}
      </div>
      <button
        type="button"
        title={visible ? 'Hide lines' : 'Show lines'}
        onClick={onToggle}
        className="pointer-events-auto inline-flex shrink-0 text-fg-subtle hover:text-fg"
      >
        <Eye size={12} />
      </button>
    </div>
  );
}
