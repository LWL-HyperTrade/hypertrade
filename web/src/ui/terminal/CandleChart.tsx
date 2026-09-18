import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ALL_CANDLE_INTERVALS,
  intervalLabel,
  type Candle,
  type CandleInterval,
} from '../../lib/hlMarket';
import {
  getSavedChartEngine,
  getSavedChartMode,
  getSavedChartTimezone,
  getShowHighLow,
  getShowOhlcv,
  getShowPositionLines,
  getVisibleChartIntervals,
  saveChartEngine,
  saveChartInterval,
  saveChartMode,
  saveChartTimezone,
  saveShowHighLow,
  saveShowOhlcv,
  saveShowPositionLines,
  saveVisibleChartIntervals,
  type ChartEngine,
  type ChartMode,
} from '../../lib/chartPrefs';
import type { ChartPriceLine } from '../../lib/chartLines';
import { resolveChartTimezone, formatZoneClock } from '../../lib/chartTimezone';
import { IconCandles, IconChevron, IconGear, IconLineChart } from '../icons';
import { ChartTimezone } from './ChartTimezone';
import { ChartWatermark, type ChartWatermarkBrand } from './ChartWatermark';
import { LightweightChartPane } from './LightweightChartPane';

const KLineChartPane = lazy(() => import('./KLineChartPane'));

type Menu = 'gear' | 'tz' | 'tf' | 'mode' | null;

const MOBILE_TF_MAX = 7;
const NARROW_MQ = '(max-width: 639px)';

function capToolbar(ids: CandleInterval[], current: CandleInterval, cap: number) {
  if (ids.length <= cap) return ids;
  const idx = ids.indexOf(current);
  if (idx >= 0 && idx < cap) return ids.slice(0, cap);
  return [current, ...ids.filter((id) => id !== current)].slice(0, cap);
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(NARROW_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

type Props = {
  candles: Candle[];
  interval: CandleInterval;
  onInterval: (next: CandleInterval) => void;
  symbol: string;
  watermark?: ChartWatermarkBrand | null;
  /** Live position / open-order lines for `symbol` (gear toggle controls visibility). */
  lines?: ChartPriceLine[];
};

function GearToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between rounded px-1.5 py-1.5 text-[11px] hover:bg-fill-hover"
    >
      <span className="text-fg-muted">{label}</span>
      <span className={`font-semibold ${on ? 'text-brand' : 'text-fg-subtle'}`}>{on ? 'On' : 'Off'}</span>
    </button>
  );
}

export function CandleChart({ candles, interval, onInterval, symbol, watermark, lines }: Props) {
  const [visible, setVisible] = useState<CandleInterval[]>(() => getVisibleChartIntervals());
  const [engine] = useState<ChartEngine>(() => {
    const saved = getSavedChartEngine();
    if (saved === 'tv') saveChartEngine('kline');
    return 'kline';
  });
  const [chartMode, setChartMode] = useState<ChartMode>(() => getSavedChartMode());
  const [showHighLow, setShowHighLow] = useState(() => getShowHighLow());
  const [showOhlcv, setShowOhlcv] = useState(() => getShowOhlcv());
  const [showLines, setShowLines] = useState(() => getShowPositionLines());
  const [timezone, setTimezone] = useState(() => resolveChartTimezone(getSavedChartTimezone()));
  const [menu, setMenu] = useState<Menu>(null);
  const [fxSlot, setFxSlot] = useState<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  useEffect(() => {
    setShowOhlcv(getShowOhlcv(narrow));
  }, [narrow]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const toolbar = visible.includes(interval) ? visible : [interval, ...visible];
  const shownToolbar = narrow ? capToolbar(toolbar, interval, MOBILE_TF_MAX) : toolbar;
  const toggleMenu = (id: Exclude<Menu, null>) => setMenu((m) => (m === id ? null : id));

  const pickInterval = (id: CandleInterval) => {
    saveChartInterval(id);
    onInterval(id);
  };

  const pickMode = (next: ChartMode) => {
    saveChartMode(next);
    setChartMode(next);
    setMenu(null);
  };

  const toggleVisible = (id: CandleInterval) => {
    setVisible((prev) => {
      const on = prev.includes(id);
      if (on && prev.length <= 1) return prev;
      const next = on
        ? prev.filter((x) => x !== id)
        : [...prev, id].sort((a, b) => ALL_CANDLE_INTERVALS.indexOf(a) - ALL_CANDLE_INTERVALS.indexOf(b));
      saveVisibleChartIntervals(next);
      if (on && id === interval && next[0]) {
        saveChartInterval(next[0]);
        onInterval(next[0]);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div ref={menuRef} className="relative flex shrink-0 items-center gap-1 border-b border-stroke-weak px-1.5 py-1 sm:gap-2 sm:px-2">
        <span className="hidden shrink-0 text-[11px] font-medium text-fg-muted sm:inline">{symbol} · Perp</span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {shownToolbar.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => pickInterval(id)}
                className={`shrink-0 rounded-[2px] px-1.5 py-0.5 text-[11px] leading-none ${
                  interval === id ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
                }`}
              >
                {intervalLabel(id)}
              </button>
            ))}
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              title="Timeframes"
              aria-expanded={menu === 'tf'}
              onClick={() => toggleMenu('tf')}
              className={`rounded-[2px] px-0.5 py-0.5 ${
                menu === 'tf' ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
              }`}
            >
              <IconChevron size={12} />
            </button>
            {menu === 'tf' ? (
              <div className="absolute left-0 top-full z-30 mt-1 w-[min(16rem,calc(100vw-1rem))] rounded-md border border-stroke-weak bg-background p-2 shadow-lg">
                <p className="mb-1.5 px-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Timeframes</p>
                <div className="grid grid-cols-4 gap-1">
                  {ALL_CANDLE_INTERVALS.map((id) => {
                    const on = visible.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleVisible(id)}
                        className={`rounded px-1.5 py-1 text-[11px] font-semibold ${
                          on ? 'bg-brand-soft text-brand' : 'bg-fill-weak text-fg-subtle hover:text-fg'
                        }`}
                      >
                        {intervalLabel(id)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              title={chartMode === 'line' ? 'Smooth line' : 'Candlesticks'}
              aria-expanded={menu === 'mode'}
              onClick={() => toggleMenu('mode')}
              className={`inline-flex h-7 items-center justify-center rounded-[2px] p-1 ${
                menu === 'mode' ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
              }`}
            >
              {chartMode === 'line' ? <IconLineChart size={16} /> : <IconCandles size={16} />}
            </button>
            {menu === 'mode' ? (
              <div className="absolute left-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-md border border-stroke-weak bg-background py-1 shadow-lg">
                {(
                  [
                    { id: 'candle', label: 'Candlesticks', Icon: IconCandles },
                    { id: 'line', label: 'Smooth line', Icon: IconLineChart },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => pickMode(opt.id)}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                      chartMode === opt.id ? 'text-fg' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                    }`}
                  >
                    <opt.Icon size={15} />
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {engine === 'kline' ? (
            <>
              <span className="mx-1 h-3.5 w-px shrink-0 bg-stroke-strong" aria-hidden />
              <div ref={setFxSlot} className="relative flex h-7 shrink-0 items-center" />
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="hidden sm:block">
            <ChartTimezone
              timezone={timezone}
              open={menu === 'tz'}
              onToggle={() => toggleMenu('tz')}
              onPick={(id) => {
                saveChartTimezone(id);
                setTimezone(id);
                setMenu(null);
              }}
            />
          </div>
          <span className="mx-0.5 hidden h-3.5 w-px shrink-0 bg-stroke-strong sm:block" aria-hidden />
          <button
            type="button"
            aria-label="Chart settings"
            aria-expanded={menu === 'gear'}
            onClick={() => toggleMenu('gear')}
            className={`inline-flex h-7 shrink-0 items-center justify-center rounded-[2px] p-1 ${
              menu === 'gear' ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
            }`}
          >
            <IconGear size={12} />
          </button>
        </div>
        {menu === 'tz' ? (
          <div className="absolute right-1 top-full z-30 mt-1 sm:hidden">
            <ChartTimezone
              timezone={timezone}
              open
              hideTrigger
              onToggle={() => setMenu(null)}
              onPick={(id) => {
                saveChartTimezone(id);
                setTimezone(id);
                setMenu(null);
              }}
            />
          </div>
        ) : null}
        {menu === 'gear' ? (
          <div className="absolute right-1 top-full z-20 mt-1 w-[min(100%,16rem)] rounded-md border border-stroke-weak bg-background p-2 shadow-lg sm:right-2">
            <p className="mb-1 px-0.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle">Display</p>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded px-1.5 py-1.5 text-[11px] hover:bg-fill-hover sm:hidden"
              onClick={() => setMenu('tz')}
            >
              <span className="text-fg-muted">Timezone</span>
              <span className="font-semibold text-fg">{formatZoneClock(timezone)}</span>
            </button>
            <GearToggle
              label="High / low labels"
              on={showHighLow}
              onToggle={() => {
                const next = !showHighLow;
                saveShowHighLow(next);
                setShowHighLow(next);
              }}
            />
            <GearToggle
              label="OHLCV values"
              on={showOhlcv}
              onToggle={() => {
                const next = !showOhlcv;
                saveShowOhlcv(next);
                setShowOhlcv(next);
              }}
            />
            <GearToggle
              label="Positions & orders"
              on={showLines}
              onToggle={() => {
                const next = !showLines;
                saveShowPositionLines(next);
                setShowLines(next);
              }}
            />
          </div>
        ) : null}
      </div>
      {engine === 'kline' ? (
        <Suspense fallback={<div className="min-h-0 flex-1 bg-background" />}>
          <KLineChartPane
            candles={candles}
            interval={interval}
            symbol={symbol}
            fxSlot={fxSlot}
            timezone={timezone}
            chartMode={chartMode}
            showHighLow={showHighLow}
            showOhlcv={showOhlcv}
            watermark={watermark}
            lines={lines}
            showLines={showLines}
          />
        </Suspense>
      ) : (
        <div className="relative min-h-0 flex-1">
          <LightweightChartPane candles={candles} timezone={timezone} chartMode={chartMode} />
          <ChartWatermark brand={watermark} />
        </div>
      )}
    </div>
  );
}
