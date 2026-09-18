import { registerIndicator, type Chart, type KLineData } from 'klinecharts';
import {
  enabledAverageRows,
  barSource,
  emaSeries,
  smaSeries,
  type MaPriceSource,
  type WebIndicatorPrefs,
} from './indicatorPrefs';

export const MA_WEB = 'MA_WEB';
export const EMA_WEB = 'EMA_WEB';
export const VWAP_WEB = 'VWAP_WEB';

type AvgExtend = { sources?: MaPriceSource[] };

function figuresFor(shortName: string, params: unknown[]) {
  return params.map((p, i) => ({
    key: `ma${i + 1}`,
    title: `${shortName}${p}: `,
    type: 'line' as const,
  }));
}

function calcAverage(kind: 'sma' | 'ema', dataList: KLineData[], indicator: { calcParams: unknown[]; extendData: unknown }) {
  const params = indicator.calcParams.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 2);
  const sources = (indicator.extendData as AvgExtend | undefined)?.sources ?? [];
  const cache = new Map<string, number[]>();
  const series = params.map((period, i) => {
    const src = sources[i] ?? 'close';
    let prices = cache.get(src);
    if (!prices) {
      prices = dataList.map((b) => barSource(b, src));
      cache.set(src, prices);
    }
    return kind === 'ema' ? emaSeries(prices, period) : smaSeries(prices, period);
  });
  return dataList.map((_, i) => {
    const row: Record<string, number> = {};
    for (let idx = 0; idx < series.length; idx++) {
      const v = series[idx][i];
      if (v != null) row[`ma${idx + 1}`] = v;
    }
    return row;
  });
}

let registered = false;

export function ensureKlineAverages() {
  if (registered) return;
  registered = true;
  for (const spec of [
    { name: MA_WEB, shortName: 'MA', kind: 'sma' as const, calcParams: [7, 25, 99] },
    { name: EMA_WEB, shortName: 'EMA', kind: 'ema' as const, calcParams: [7, 50, 200] },
  ]) {
    registerIndicator({
      name: spec.name,
      shortName: spec.shortName,
      series: 'price',
      calcParams: spec.calcParams,
      figures: figuresFor(spec.shortName, spec.calcParams),
      regenerateFigures: (params) => figuresFor(spec.shortName, params),
      shouldUpdate: (prev, curr) => {
        const calc =
          JSON.stringify(prev.calcParams) !== JSON.stringify(curr.calcParams) ||
          JSON.stringify(prev.extendData) !== JSON.stringify(curr.extendData);
        return { calc, draw: true };
      },
      calc: (dataList, indicator) => calcAverage(spec.kind, dataList, indicator),
    });
  }
  registerIndicator({
    name: VWAP_WEB,
    shortName: 'VWAP',
    series: 'price',
    calcParams: [14],
    figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
    regenerateFigures: (params) => [{ key: 'vwap', title: `VWAP${params[0] ?? ''}: `, type: 'line' }],
    calc: (dataList, indicator) => {
      const period = Math.max(2, Math.round(Number(indicator.calcParams[0]) || 14));
      return dataList.map((_, i) => {
        const from = Math.max(0, i - period + 1);
        let pv = 0;
        let vol = 0;
        for (let j = from; j <= i; j++) {
          const d = dataList[j];
          const tp = (d.high + d.low + d.close) / 3;
          const v = d.volume ?? 0;
          pv += tp * v;
          vol += v;
        }
        return vol > 0 ? { vwap: pv / vol } : {};
      });
    },
  });
}

function syncAverage(
  chart: Chart,
  name: string,
  shortName: string,
  rows: ReturnType<typeof enabledAverageRows>,
  visible = true,
) {
  const existing = chart.getIndicators({ name });
  if (!rows.length) {
    if (existing.length) chart.removeIndicator({ name });
    return;
  }
  const payload = {
    name,
    shortName,
    visible,
    calcParams: rows.map((r) => r.period),
    extendData: { sources: rows.map((r) => r.source) } satisfies AvgExtend,
    paneId: 'candle_pane',
    styles: {
      lines: rows.map((r) => ({ color: r.color })),
      tooltip: overlayTooltip(),
    },
  };
  if (existing.length) {
    chart.overrideIndicator(payload);
    return;
  }
  chart.createIndicator(payload, true);
}

function syncNamed(
  chart: Chart,
  name: string,
  on: boolean,
  opts: { overlay?: boolean; calcParams?: number[]; styles?: { lines: { color: string; size?: number }[] }; visible?: boolean } = {},
) {
  const existing = chart.getIndicators({ name });
  if (!on) {
    if (existing.length) chart.removeIndicator({ name });
    return;
  }
  if (existing.length > 1) {
    chart.removeIndicator({ name });
  }
  const payload = {
    name,
    visible: opts.visible !== false,
    calcParams: opts.calcParams,
    styles: {
      ...opts.styles,
      ...(opts.overlay ? { tooltip: overlayTooltip() } : {}),
    },
    ...(opts.overlay ? { paneId: 'candle_pane' } : {}),
  };
  if (existing.length === 1) {
    chart.overrideIndicator(payload);
    return;
  }
  chart.createIndicator(payload, !!opts.overlay);
}

const LEGEND_LEFT = 28;

/** Candle tooltip: OHLCV only — no time (crosshair / axis already show it). */
const OHLCV_LEGEND_TEMPLATE = [
  { title: 'O: ', value: '{open}' },
  { title: 'H: ', value: '{high}' },
  { title: 'L: ', value: '{low}' },
  { title: 'C: ', value: '{close}' },
  { title: 'V: ', value: '{volume}' },
];

function candleOhlcvTooltip(show: boolean) {
  return {
    showRule: (show ? 'always' : 'none') as 'always' | 'none',
    offsetLeft: LEGEND_LEFT,
    offsetTop: 6,
    title: { show: false },
    legend: {
      size: 11,
      marginTop: 2,
      marginBottom: 2,
      template: OHLCV_LEGEND_TEMPLATE,
    },
  };
}

function overlayTooltip() {
  return { offsetLeft: LEGEND_LEFT, showRule: 'none' as const };
}

function applyLegendVisibility(chart: Chart, collapsed: boolean, showOhlcv: boolean) {
  chart.setStyles({
    candle: { tooltip: candleOhlcvTooltip(!collapsed && showOhlcv) },
    indicator: { tooltip: { showRule: 'none', offsetLeft: LEGEND_LEFT } },
  });
}

const NEON = '#4ef2bb';

export function applyChartDisplay(
  chart: Chart,
  opts: { mode: 'candle' | 'line'; showHighLow: boolean; showOhlcv: boolean; legendCollapsed?: boolean },
) {
  chart.setStyles({
    candle: {
      type: opts.mode === 'line' ? 'area' : 'candle_solid',
      area: {
        lineSize: 2,
        lineColor: NEON,
        smooth: true,
        backgroundColor: [
          { offset: 0, color: 'rgba(78, 242, 187, 0.32)' },
          { offset: 1, color: 'rgba(78, 242, 187, 0.02)' },
        ],
        point: {
          show: true,
          color: NEON,
          radius: 3,
          rippleColor: 'rgba(78, 242, 187, 0.35)',
          rippleRadius: 10,
          animation: true,
        },
      },
      priceMark: {
        high: { show: opts.showHighLow },
        low: { show: opts.showHighLow },
      },
      tooltip: candleOhlcvTooltip(!opts.legendCollapsed && opts.showOhlcv),
    },
    indicator: { tooltip: { showRule: 'none', offsetLeft: LEGEND_LEFT } },
  });
}

export function applyIndicatorPrefs(
  chart: Chart,
  prefs: WebIndicatorPrefs,
  legendCollapsed = false,
  showOhlcv = true,
) {
  syncAverage(chart, EMA_WEB, 'EMA', enabledAverageRows(prefs.emaRows), prefs.emaVisible);
  syncAverage(chart, MA_WEB, 'MA', enabledAverageRows(prefs.maRows), prefs.maVisible);
  syncNamed(chart, VWAP_WEB, prefs.vwap, {
    overlay: true,
    visible: prefs.vwapVisible !== false,
    calcParams: [Math.max(2, prefs.vwapLength || 14)],
    styles: { lines: [{ color: prefs.vwapColor, size: prefs.vwapLineWidth || 2 }] },
  });
  syncNamed(chart, 'BOLL', prefs.boll, {
    overlay: true,
    visible: prefs.bollVisible !== false,
    calcParams: [Math.max(2, prefs.bollLength || 20), prefs.bollMult || 2],
    styles: { lines: prefs.bollColors.map((color) => ({ color })) },
  });
  syncNamed(chart, 'VOL', prefs.vol, { calcParams: [] });
  syncNamed(chart, 'MACD', prefs.macd, { calcParams: prefs.macdParams });
  syncNamed(chart, 'RSI', prefs.rsi, { calcParams: [Math.max(2, prefs.rsiPeriod || 14)] });
  applyLegendVisibility(chart, legendCollapsed, showOhlcv);
}
