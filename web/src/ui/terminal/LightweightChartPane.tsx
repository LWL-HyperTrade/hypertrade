import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../../lib/hlMarket';
import type { ChartMode } from '../../lib/chartPrefs';

function unixMs(time: Time): number {
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') return Number(time) * 1000;
  return Date.UTC(time.year, time.month - 1, time.day);
}

function formatLwcTime(time: Time, timeZone: string, type?: TickMarkType): string {
  const d = new Date(unixMs(time));
  const opts: Intl.DateTimeFormatOptions = { timeZone, hour12: false };
  if (type === TickMarkType.Year) opts.year = 'numeric';
  else if (type === TickMarkType.Month) {
    opts.month = 'short';
    opts.year = '2-digit';
  } else if (type === TickMarkType.DayOfMonth) {
    opts.day = 'numeric';
    opts.month = 'short';
  } else {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
  }
  return new Intl.DateTimeFormat('en-GB', opts).format(d);
}

export function LightweightChartPane({
  candles,
  timezone,
  chartMode,
}: {
  candles: Candle[];
  timezone: string;
  chartMode: ChartMode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lineRef = useRef<ISeriesApi<'Area'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const histFirstRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      width: host.clientWidth || 400,
      height: host.clientHeight || 280,
      layout: {
        background: { type: ColorType.Solid, color: '#12131a' },
        textColor: '#ffffff99',
        fontFamily: '"Basel Grotesk", Basel, Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#ffffff0f' },
        horzLines: { color: '#ffffff0f' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#ffffff1f' },
      timeScale: {
        borderColor: '#ffffff1f',
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 8,
        rightOffset: 8,
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatLwcTime(time, timezone, type),
      },
      localization: {
        locale: 'en-US',
        timeFormatter: (time: Time) => formatLwcTime(time, timezone),
      },
    });

    const candlesSeries = chart.addCandlestickSeries({
      upColor: '#77c7af',
      downColor: '#ff9c9c',
      borderUpColor: '#77c7af',
      borderDownColor: '#ff9c9c',
      wickUpColor: '#77c7af',
      wickDownColor: '#ff9c9c',
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    const line = chart.addAreaSeries({
      lineColor: '#4ef2bb',
      topColor: 'rgba(78, 242, 187, 0.28)',
      bottomColor: 'rgba(78, 242, 187, 0.02)',
      lineWidth: 2,
      visible: false,
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    chartRef.current = chart;
    candleRef.current = candlesSeries;
    lineRef.current = line;
    volRef.current = volume;

    const ro = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      volRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType) => formatLwcTime(time, timezone, type),
      },
      localization: {
        timeFormatter: (time: Time) => formatLwcTime(time, timezone),
      },
    });
  }, [timezone]);

  useEffect(() => {
    const isLine = chartMode === 'line';
    candleRef.current?.applyOptions({ visible: !isLine });
    lineRef.current?.applyOptions({ visible: isLine });
  }, [chartMode]);

  useEffect(() => {
    if (!candleRef.current || !volRef.current || !lineRef.current) return;
    if (candles.length < 2) {
      candleRef.current.setData([]);
      lineRef.current.setData([]);
      volRef.current.setData([]);
      return;
    }
    const rows = candles.map((c) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    }));
    const line = candles.map((c) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      value: c.c,
    }));
    const vols = candles.map((c) => ({
      time: Math.floor(c.t / 1000) as UTCTimestamp,
      value: c.v,
      color: c.c >= c.o ? '#77c7af55' : '#ff9c9c55',
    }));
    candleRef.current.setData(rows);
    lineRef.current.setData(line);
    volRef.current.setData(vols);
    const first = candles[0]?.t ?? null;
    if (first != null && first !== histFirstRef.current) {
      histFirstRef.current = first;
      chartRef.current?.timeScale().applyOptions({ barSpacing: 8, rightOffset: 8 });
    }
  }, [candles]);

  return (
    <div
      ref={hostRef}
      className={`min-h-0 flex-1 transition-opacity duration-300 ${candles.length < 2 ? 'opacity-25' : 'opacity-100'}`}
    />
  );
}
