import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HL_WS_URL,
  isSpotBookCoin,
  type AssetCtx,
  type Candle,
  type CandleInterval,
  type L2Book,
  type TapeTrade,
  fetchAssetCtx,
  fetchChartCandles,
  fetchL2Book,
  l2BookRequest,
  chartLookbackMs,
  num,
  parseL2Book,
} from './hlMarket';
import { INDICATOR_PREFS_EVENT, loadIndicatorPrefs, maxEnabledAveragePeriod } from './indicatorPrefs';
import {
  foldDailyLiveIntoMonthBar,
  foldDailyLiveIntoWeekBar,
  isCalendarBarInterval,
  isCalendarMonthInterval,
} from './calendarBars';

export type HlMarketState = {
  book: L2Book | null;
  trades: TapeTrade[];
  ctx: AssetCtx | null;
  candles: Candle[];
  connected: boolean;
};

const empty: HlMarketState = {
  book: null,
  trades: [],
  ctx: null,
  candles: [],
  connected: false,
};

function parseCtx(raw: unknown): AssetCtx {
  const ctx = (raw ?? {}) as Record<string, unknown>;
  return {
    markPx: num(ctx.markPx),
    midPx: num(ctx.midPx),
    prevDayPx: num(ctx.prevDayPx),
    funding: num(ctx.funding),
    openInterest: num(ctx.openInterest),
    dayNtlVlm: num(ctx.dayNtlVlm),
  };
}

function parseTrades(raw: unknown, coin: string): TapeTrade[] {
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows
    .map((row, i) => {
      const t = row as Record<string, unknown>;
      const px = num(t.px);
      const sz = num(t.sz);
      const time = num(t.time) ?? Date.now();
      if (px == null || sz == null) return null;
      const side = t.side === 'A' || t.side === 'sell' ? 'A' : 'B';
      return {
        coin: String(t.coin ?? coin),
        side,
        px,
        sz,
        time,
        key: `${time}-${px}-${sz}-${t.hash ?? i}`,
      } satisfies TapeTrade;
    })
    .filter((x): x is TapeTrade => !!x);
}

/** Keep warmup bars for MA200; do not trim to a short live window. */
const MAX_LIVE_CANDLES = 2500;

function upsertCandle(list: Candle[], next: Candle): Candle[] {
  if (!next.t) return list;
  const i = list.findIndex((c) => c.t === next.t);
  if (i === -1) {
    const out = [...list, next].sort((a, b) => a.t - b.t);
    return out.length > MAX_LIVE_CANDLES ? out.slice(out.length - MAX_LIVE_CANDLES) : out;
  }
  const copy = list.slice();
  copy[i] = next;
  return copy;
}

export function useHlMarket(
  coin: string,
  interval: CandleInterval,
  opts?: {
    spot?: boolean;
    /** Order-book grouping as HL significant figures (2–5). `null` = finest. */
    bookSigFigs?: number | null;
  },
): HlMarketState {
  const [state, setState] = useState<HlMarketState>(empty);
  const coinRef = useRef(coin);
  coinRef.current = coin;
  const bookSigFigs = opts?.bookSigFigs ?? null;
  const sigFigsRef = useRef<number | null>(bookSigFigs);
  const wsRef = useRef<WebSocket | null>(null);

  const isSpot = opts?.spot || isSpotBookCoin(coin);
  const [maxIndicatorPeriod, setMaxIndicatorPeriod] = useState(() =>
    maxEnabledAveragePeriod(loadIndicatorPrefs()),
  );

  useEffect(() => {
    const sync = () => setMaxIndicatorPeriod(maxEnabledAveragePeriod(loadIndicatorPrefs()));
    window.addEventListener(INDICATOR_PREFS_EVENT, sync);
    return () => window.removeEventListener(INDICATOR_PREFS_EVENT, sync);
  }, []);

  const historyReadyRef = useRef(false);

  useEffect(() => {
    if (!coin) {
      historyReadyRef.current = false;
      setState((s) => ({ ...s, candles: [] }));
      return;
    }
    let cancelled = false;
    historyReadyRef.current = false;
    setState((s) => ({ ...s, candles: [] }));
    void fetchChartCandles(coin, interval, chartLookbackMs(interval, maxIndicatorPeriod)).then((candles) => {
      if (cancelled || coinRef.current !== coin) return;
      historyReadyRef.current = true;
      setState((s) => ({ ...s, candles }));
    });
    return () => {
      cancelled = true;
    };
  }, [coin, interval, maxIndicatorPeriod]);

  useEffect(() => {
    if (!coin) {
      setState(empty);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    // Never keep the previous coin's mid/mark — ticket + header would show wrong px.
    setState(empty);

    void Promise.allSettled([fetchL2Book(coin, sigFigsRef.current), fetchAssetCtx(coin, { spot: isSpot })]).then(([book, ctx]) => {
      if (cancelled || coinRef.current !== coin) return;
      setState((s) => ({
        ...s,
        book: book.status === 'fulfilled' ? book.value : s.book,
        ctx: ctx.status === 'fulfilled' ? ctx.value : s.ctx,
      }));
    });

    // WS snapshots can be thin on some coins — refresh REST book so depth fills.
    const bookPoll = setInterval(() => {
      const sig = sigFigsRef.current;
      void fetchL2Book(coin, sig).then((book) => {
        // Grouping changed while this was in flight — the resubscribe effect owns it now.
        if (cancelled || coinRef.current !== coin || sigFigsRef.current !== sig) return;
        setState((s) => {
          const prev = (s.book?.bids.length ?? 0) + (s.book?.asks.length ?? 0);
          const next = book.bids.length + book.asks.length;
          return next >= prev ? { ...s, book } : s;
        });
      });
    }, 4_000);
    const candleFeed = isCalendarBarInterval(interval) ? '1d' : interval;
    const subscribe = (socket: WebSocket) => {
      const subs = [
        l2BookRequest(coin, sigFigsRef.current),
        { type: 'trades', coin },
        { type: isSpot ? 'activeSpotAssetCtx' : 'activeAssetCtx', coin },
        { type: 'candle', coin, interval: candleFeed },
      ];
      for (const subscription of subs) {
        socket.send(JSON.stringify({ method: 'subscribe', subscription }));
      }
    };

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(HL_WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setState((s) => ({ ...s, connected: true }));
        subscribe(ws!);
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ method: 'ping' }));
          }
        }, 20_000);
      };
      ws.onmessage = (ev) => {
        if (cancelled || coinRef.current !== coin) return;
        let msg: { channel?: string; data?: unknown };
        try {
          msg = JSON.parse(String(ev.data)) as { channel?: string; data?: unknown };
        } catch {
          return;
        }
        if (msg.channel === 'l2Book') {
          setState((s) => ({ ...s, book: parseL2Book(msg.data, coin) }));
          return;
        }
        if (msg.channel === 'trades') {
          const next = parseTrades(msg.data, coin);
          if (!next.length) return;
          setState((s) => ({ ...s, trades: [...next, ...s.trades].slice(0, 80) }));
          return;
        }
        if (msg.channel === 'activeAssetCtx' || msg.channel === 'activeSpotAssetCtx') {
          const data = msg.data as { ctx?: unknown } | undefined;
          if (data?.ctx) setState((s) => ({ ...s, ctx: parseCtx(data.ctx) }));
          return;
        }
        if (msg.channel === 'candle') {
          // Live WS often delivers the current bar before REST history — skip until candles exist.
          if (!historyReadyRef.current) return;
          const c = msg.data as Record<string, unknown> | undefined;
          if (!c) return;
          const candle: Candle = {
            t: num(c.t) ?? 0,
            o: num(c.o) ?? 0,
            h: num(c.h) ?? 0,
            l: num(c.l) ?? 0,
            c: num(c.c) ?? 0,
            v: num(c.v) ?? 0,
          };
          setState((s) => {
            const next = isCalendarBarInterval(interval)
              ? isCalendarMonthInterval(interval)
                ? foldDailyLiveIntoMonthBar(candle, s.candles[s.candles.length - 1] ?? null)
                : foldDailyLiveIntoWeekBar(candle, s.candles[s.candles.length - 1] ?? null)
              : candle;
            return { ...s, candles: upsertCandle(s.candles, next) };
          });
        }
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (pingTimer) clearInterval(pingTimer);
        if (cancelled) return;
        const wait = Math.min(8_000, 300 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, wait);
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      cancelled = true;
      clearInterval(bookPoll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (wsRef.current === ws) wsRef.current = null;
      if (ws && ws.readyState <= 1) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [coin, interval, isSpot]);

  // Grouping change: swap only the l2Book subscription on the live socket
  // (trades / ctx / candles keep streaming) and refresh the REST snapshot at
  // the new granularity so the book repaints immediately.
  useEffect(() => {
    const prev = sigFigsRef.current;
    if (prev === bookSigFigs) return;
    sigFigsRef.current = bookSigFigs;
    if (!coin) return;
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ method: 'unsubscribe', subscription: l2BookRequest(coin, prev) }));
      socket.send(JSON.stringify({ method: 'subscribe', subscription: l2BookRequest(coin, bookSigFigs) }));
    }
    let cancelled = false;
    void fetchL2Book(coin, bookSigFigs).then((book) => {
      if (cancelled || coinRef.current !== coin || sigFigsRef.current !== bookSigFigs) return;
      setState((s) => ({ ...s, book }));
    });
    return () => {
      cancelled = true;
    };
  }, [bookSigFigs, coin]);

  return useMemo(() => state, [state]);
}
