import type { Candle, CandleInterval } from './hlMarket';

/** Chart `1M` is UTC calendar months, not HL’s rolling 30-day native interval. */
export function isCalendarMonthInterval(interval: CandleInterval): boolean {
  return interval === '1M';
}

/** Chart `1w` is Monday 00:00 UTC, not HL’s Thursday-aligned native interval. */
export function isCalendarWeekInterval(interval: CandleInterval): boolean {
  return interval === '1w';
}

export function isCalendarBarInterval(interval: CandleInterval): boolean {
  return isCalendarMonthInterval(interval) || isCalendarWeekInterval(interval);
}

function asMs(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return NaN;
  return t < 1e12 ? t * 1000 : t;
}

/** UTC week open: Monday 00:00 UTC (ISO). HL native `1w` is epoch/Thursday. */
export function utcMondayStartMs(tsMs: number): number {
  const d = new Date(asMs(tsMs));
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
}

/** UTC calendar month open: 1st 00:00 UTC. */
export function utcMonthStartMs(tsMs: number): number {
  const d = new Date(asMs(tsMs));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function aggregateDailyToBuckets(daily: Candle[], keyMs: (t: number) => number): Candle[] {
  const sorted = daily
    .filter((c) => Number.isFinite(c.t) && c.t > 0)
    .slice()
    .sort((a, b) => a.t - b.t);

  const bars: Candle[] = [];
  let cur: Candle | null = null;
  let curKey = -1;

  const flush = () => {
    if (!cur) return;
    bars.push({ ...cur, t: curKey });
  };

  for (const d of sorted) {
    const key = keyMs(d.t);
    if (!Number.isFinite(key)) continue;
    if (key !== curKey) {
      flush();
      curKey = key;
      cur = { t: key, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v };
    } else if (cur) {
      cur.h = Math.max(cur.h, d.h);
      cur.l = Math.min(cur.l, d.l);
      cur.c = d.c;
      cur.v += d.v;
    }
  }
  flush();
  return bars;
}

export function aggregateDailyToCalendarWeeks(daily: Candle[]): Candle[] {
  return aggregateDailyToBuckets(daily, utcMondayStartMs);
}

export function aggregateDailyToCalendarMonths(daily: Candle[]): Candle[] {
  return aggregateDailyToBuckets(daily, utcMonthStartMs);
}

function foldDailyLiveIntoBucket(daily: Candle, seed: Candle | null, bucketStart: number): Candle {
  if (seed && seed.t === bucketStart) {
    return {
      t: bucketStart,
      o: seed.o,
      h: Math.max(seed.h, daily.h),
      l: Math.min(seed.l, daily.l),
      c: daily.c,
      v: seed.v,
    };
  }
  return { t: bucketStart, o: daily.o, h: daily.h, l: daily.l, c: daily.c, v: daily.v };
}

export function foldDailyLiveIntoWeekBar(daily: Candle, seed: Candle | null): Candle {
  return foldDailyLiveIntoBucket(daily, seed, utcMondayStartMs(daily.t));
}

export function foldDailyLiveIntoMonthBar(daily: Candle, seed: Candle | null): Candle {
  return foldDailyLiveIntoBucket(daily, seed, utcMonthStartMs(daily.t));
}
