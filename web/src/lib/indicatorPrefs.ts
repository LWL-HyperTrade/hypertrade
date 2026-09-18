/**
 * Chart indicator editor prefs — same row model as mobile (`frontend/src/lib/indicatorPrefs.ts`).
 * localStorage, not owner-scoped (web desk is one chart).
 */

export const MA_BAND_SLOT_COUNT = 6;

export type MaPriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'ohlc4';

export type MaBandRow = {
  enabled: boolean;
  period: number;
  source: MaPriceSource;
  color: string;
};

export const MA_SOURCE_OPTIONS: { id: MaPriceSource; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
  { id: 'close', label: 'Close' },
  { id: 'hl2', label: 'HL2' },
  { id: 'ohlc4', label: 'OHLC4' },
];

export const CHART_COLOR_PRESETS = [
  '#4ef2bb',
  '#ef4444',
  '#22d3ee',
  '#a855f7',
  '#ec4899',
  '#e5e7eb',
  '#f59e0b',
  '#22c55e',
  '#60a5fa',
  '#f97316',
  '#34d399',
  '#facc15',
  '#94a3b8',
  '#ffffff',
];

const EMA_SLOT_PERIODS = [3, 7, 20, 50, 100, 200];
/** First three match the previous web default MA 7 / 25 / 99. */
const MA_SLOT_PERIODS = [7, 25, 99, 50, 100, 200];

const EMA_DEFAULT_COLORS = ['#ef4444', '#22d3ee', '#a855f7', '#ec4899', '#e5e7eb', '#f59e0b'];
const MA_DEFAULT_COLORS = ['#4ef2bb', '#27d821', '#5eead4', '#f97316', '#f472b6', '#94a3b8'];

export const DEFAULT_EMA_ROWS: MaBandRow[] = EMA_SLOT_PERIODS.map((period, i) => ({
  enabled: false,
  period,
  source: 'close',
  color: EMA_DEFAULT_COLORS[i] ?? '#eab308',
}));

export const DEFAULT_MA_ROWS: MaBandRow[] = MA_SLOT_PERIODS.map((period, i) => ({
  enabled: i < 3,
  period,
  source: 'close',
  color: MA_DEFAULT_COLORS[i] ?? '#94a3b8',
}));

export type AverageTab = 'ema' | 'ma';

export type WebIndicatorPrefs = {
  emaRows: MaBandRow[];
  maRows: MaBandRow[];
  emaVisible: boolean;
  maVisible: boolean;
  vwap: boolean;
  vwapVisible: boolean;
  vwapLength: number;
  vwapColor: string;
  vwapLineWidth: 1 | 2 | 3 | 4;
  boll: boolean;
  bollVisible: boolean;
  bollLength: number;
  bollMult: number;
  bollColors: [string, string, string];
  vol: boolean;
  macd: boolean;
  macdParams: [number, number, number];
  rsi: boolean;
  rsiPeriod: number;
};

export const DEFAULT_BOLL_COLORS: [string, string, string] = ['#60a5fa', '#e5e7eb', '#f472b6'];

export const DEFAULT_INDICATOR_PREFS: WebIndicatorPrefs = {
  emaRows: DEFAULT_EMA_ROWS.map((r) => ({ ...r })),
  maRows: DEFAULT_MA_ROWS.map((r) => ({ ...r })),
  emaVisible: true,
  maVisible: true,
  vwap: false,
  vwapVisible: true,
  vwapLength: 14,
  vwapColor: '#3b82f6',
  vwapLineWidth: 2,
  boll: false,
  bollVisible: true,
  bollLength: 20,
  bollMult: 2,
  bollColors: DEFAULT_BOLL_COLORS,
  vol: false,
  macd: false,
  macdParams: [12, 26, 9],
  rsi: false,
  rsiPeriod: 14,
};

const KEY = 'builderpad:indicatorPrefs';
/** One-shot: volume pane used to default on; hide it unless the user turns it back on. */
const VOL_OFF_MIGRATION = 'builderpad:volOff.v1';

/** Volume pane default: on for desktop desks, off on phones where chart height is scarce. */
function defaultVol(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
  } catch {
    return false;
  }
}

function freshPrefs(): WebIndicatorPrefs {
  return {
    ...DEFAULT_INDICATOR_PREFS,
    emaRows: DEFAULT_EMA_ROWS.map((r) => ({ ...r })),
    maRows: DEFAULT_MA_ROWS.map((r) => ({ ...r })),
    bollColors: DEFAULT_BOLL_COLORS,
    macdParams: DEFAULT_INDICATOR_PREFS.macdParams,
    vol: defaultVol(),
  };
}
const SOURCE_SET = new Set<MaPriceSource>(MA_SOURCE_OPTIONS.map((o) => o.id));
const HEX6 = /^#([0-9a-fA-F]{6})$/;

function clampPeriod(n: number, fallback: number) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(999, Math.round(n)));
}

export function normalizeMaBandRow(partial: Partial<MaBandRow> | undefined, fallback: MaBandRow): MaBandRow {
  const src = partial?.source && SOURCE_SET.has(partial.source) ? partial.source : fallback.source;
  const color =
    typeof partial?.color === 'string' && HEX6.test(partial.color.trim()) ? partial.color.trim() : fallback.color;
  return {
    enabled: !!partial?.enabled,
    period: clampPeriod(Number(partial?.period), fallback.period),
    source: src,
    color,
  };
}

function normalizeRows(raw: unknown, defaults: MaBandRow[]): MaBandRow[] {
  const arr = Array.isArray(raw) ? raw : [];
  return defaults.map((def, i) => normalizeMaBandRow(arr[i] as Partial<MaBandRow> | undefined, def));
}

function migrateVolumeOff(prefs: WebIndicatorPrefs, hadSaved: boolean): WebIndicatorPrefs {
  try {
    if (localStorage.getItem(VOL_OFF_MIGRATION) === '1') return prefs;
    localStorage.setItem(VOL_OFF_MIGRATION, '1');
    if (!hadSaved || !prefs.vol) return prefs;
    const next = { ...prefs, vol: false };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return hadSaved ? { ...prefs, vol: false } : prefs;
  }
}

export function loadIndicatorPrefs(): WebIndicatorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return migrateVolumeOff(freshPrefs(), false);
    const parsed = JSON.parse(raw) as Partial<WebIndicatorPrefs>;
    const bollColors = Array.isArray(parsed.bollColors)
      ? ([0, 1, 2].map((i) =>
          typeof parsed.bollColors?.[i] === 'string' && HEX6.test(parsed.bollColors[i])
            ? parsed.bollColors[i]
            : DEFAULT_BOLL_COLORS[i],
        ) as [string, string, string])
      : DEFAULT_BOLL_COLORS;
    const macdParams = Array.isArray(parsed.macdParams)
      ? ([0, 1, 2].map((i) => clampPeriod(Number(parsed.macdParams?.[i]), DEFAULT_INDICATOR_PREFS.macdParams[i])) as [
          number,
          number,
          number,
        ])
      : DEFAULT_INDICATOR_PREFS.macdParams;
    const loaded: WebIndicatorPrefs = {
      emaRows: normalizeRows(parsed.emaRows, DEFAULT_EMA_ROWS),
      maRows: normalizeRows(parsed.maRows, DEFAULT_MA_ROWS),
      emaVisible: parsed.emaVisible !== false,
      maVisible: parsed.maVisible !== false,
      vwap: !!parsed.vwap,
      vwapVisible: parsed.vwapVisible !== false,
      vwapLength: clampPeriod(Number(parsed.vwapLength), 14) || 14,
      vwapColor:
        typeof parsed.vwapColor === 'string' && HEX6.test(parsed.vwapColor) ? parsed.vwapColor : DEFAULT_INDICATOR_PREFS.vwapColor,
      vwapLineWidth: ([1, 2, 3, 4] as const).includes(Number(parsed.vwapLineWidth) as 1 | 2 | 3 | 4)
        ? (Number(parsed.vwapLineWidth) as 1 | 2 | 3 | 4)
        : 2,
      boll: !!parsed.boll,
      bollVisible: parsed.bollVisible !== false,
      bollLength: clampPeriod(Number(parsed.bollLength), 20) || 20,
      bollMult: Number.isFinite(Number(parsed.bollMult)) ? Math.max(0.1, Math.min(50, Number(parsed.bollMult))) : 2,
      bollColors,
      vol: typeof parsed.vol === 'boolean' ? parsed.vol : defaultVol(),
      macd: !!parsed.macd,
      macdParams,
      rsi: !!parsed.rsi,
      rsiPeriod: clampPeriod(Number(parsed.rsiPeriod), 14) || 14,
    };
    return migrateVolumeOff(loaded, true);
  } catch {
    return freshPrefs();
  }
}

export const INDICATOR_PREFS_EVENT = 'builderpad:indicator-prefs';

export function saveIndicatorPrefs(prefs: WebIndicatorPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    window.dispatchEvent(new Event(INDICATOR_PREFS_EVENT));
  } catch {
    /* quota / private mode */
  }
}

/** Longest enabled MA/EMA/BOLL/VWAP/RSI/MACD period — sizes candle fetches. */
export function maxEnabledAveragePeriod(prefs: WebIndicatorPrefs): number {
  let m = 1;
  const scan = (rows: MaBandRow[]) => {
    for (const r of rows) {
      const period = Math.round(Number(r.period));
      if (r.enabled && Number.isFinite(period) && period > 0) m = Math.max(m, period);
    }
  };
  scan(prefs.maRows);
  scan(prefs.emaRows);
  if (prefs.boll) m = Math.max(m, Math.max(2, Math.round(Number(prefs.bollLength)) || 2));
  if (prefs.vwap) m = Math.max(m, Math.max(2, Math.round(Number(prefs.vwapLength)) || 2));
  if (prefs.rsi) m = Math.max(m, Math.max(2, Math.round(Number(prefs.rsiPeriod)) || 2));
  if (prefs.macd) {
    for (const n of prefs.macdParams) {
      const period = Math.round(Number(n));
      if (Number.isFinite(period) && period > 0) m = Math.max(m, period);
    }
  }
  return m;
}

export function enabledAverageRows(rows: MaBandRow[]): MaBandRow[] {
  return rows.filter((r) => r.enabled && r.period >= 2);
}

export function activeAverageRows(rows: MaBandRow[], visible: boolean): MaBandRow[] {
  if (!visible) return [];
  return enabledAverageRows(rows);
}

export function barSource(
  bar: { open: number; high: number; low: number; close: number },
  src: MaPriceSource,
): number {
  switch (src) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
    default:
      return bar.close;
  }
}

export function smaSeries(values: number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length);
  if (period < 2) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values: number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length);
  if (period < 1 || !values.length) return out;
  const k = 2 / (period + 1);
  let ema = values[0];
  out[0] = period <= 1 ? ema : undefined;
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    if (i >= period - 1) out[i] = ema;
  }
  return out;
}
