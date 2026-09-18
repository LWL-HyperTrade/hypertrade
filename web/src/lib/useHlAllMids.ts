import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { HL_WS_URL, dexFromCoin, fetchAllMids, num } from './hlMarket';

/**
 * Terminal-scoped live marks for market search.
 *
 * `allMids` only pushes about every 5s (and HIP-3 needs extra dex channels).
 * `fastAssetCtxs` is the current all-coin mark feed: ~1s, main + HIP-3 in one
 * channel, snapshot then diffs. allMids stays as a fallback until the first
 * fast frame (or if that sub is rejected).
 *
 * Does not open per-coin sockets. The selected-market book/tape stays on
 * `useHlMarket`.
 */

const FLUSH_MS = 500;
const PING_MS = 20_000;
const STALE_MS = 15_000;

type Listener = () => void;
type FastCtx = { markPx?: unknown; midPx?: unknown };

type Feed = {
  snapshot: Map<string, number>;
  listeners: Set<Listener>;
  pending: Map<string, number>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastMainAt: number;
};

const feed: Feed = {
  snapshot: new Map(),
  listeners: new Set(),
  pending: new Map(),
  flushTimer: null,
  lastMainAt: 0,
};

function emit() {
  if (!feed.pending.size) return;
  feed.snapshot = new Map(feed.snapshot);
  for (const p of feed.pending) feed.snapshot.set(p[0], p[1]);
  feed.pending.clear();
  feed.listeners.forEach((l) => l());
}

function scheduleFlush() {
  if (feed.flushTimer) return;
  feed.flushTimer = setTimeout(() => {
    feed.flushTimer = null;
    emit();
  }, FLUSH_MS);
}

function put(key: string, px: number) {
  if (!key || !Number.isFinite(px) || px <= 0) return;
  const prev = feed.pending.get(key) ?? feed.snapshot.get(key);
  if (prev === px) return;
  if (prev != null && prev > 0 && Math.abs(px - prev) / prev > 20) return;
  feed.pending.set(key, px);
  scheduleFlush();
}

function storeKey(coin: string, dex?: string | null): string {
  const raw = String(coin || '').trim();
  if (!raw) return '';
  if (dex) {
    const base = raw.includes(':') ? (raw.split(':').pop() as string) : raw;
    return `${dex}:${base}`;
  }
  return raw;
}

function applyMids(mids: Record<string, string>, dex?: string | null) {
  for (const [coin, price] of Object.entries(mids)) {
    const px = num(price);
    if (px == null) continue;
    put(storeKey(coin, dex), px);
  }
}

function applyFastCtxs(ctxs: Record<string, FastCtx>) {
  for (const [coin, ctx] of Object.entries(ctxs)) {
    if (!ctx) continue;
    const px = num(ctx.midPx) ?? num(ctx.markPx);
    if (px == null) continue;
    put(coin, px);
  }
}

async function decodeFastAssetCtxs(b64: string): Promise<Record<string, FastCtx>> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const json = await new Response(stream).text();
  const parsed = JSON.parse(json) as Record<string, FastCtx>;
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function seedRest(dexes: string[]) {
  try {
    const main = await fetchAllMids();
    applyMids(main, null);
    await Promise.all(
      dexes.map(async (dex) => {
        applyMids(await fetchAllMids(dex), dex);
      }),
    );
    if (feed.flushTimer) {
      clearTimeout(feed.flushTimer);
      feed.flushTimer = null;
    }
    emit();
  } catch {
    /* WS will fill in */
  }
}

function subscribeStore(onStoreChange: Listener) {
  feed.listeners.add(onStoreChange);
  return () => {
    feed.listeners.delete(onStoreChange);
  };
}

function getSnapshot() {
  return feed.snapshot;
}

/** Keep the mark socket warm for the mounted terminal. No React re-renders. */
export function useHlAllMidsSocket(dexes: string[]) {
  const dexKey = useMemo(() => [...new Set(dexes.map((d) => d.toLowerCase()).filter(Boolean))].sort().join(','), [dexes]);

  useEffect(() => {
    const dexList = dexKey ? dexKey.split(',').filter(Boolean) : [];
    let cancelled = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let staleTimer: ReturnType<typeof setInterval> | undefined;
    let lastMsgAt = Date.now();
    let subscribed = false;
    let fastLive = false;
    let decodeChain = Promise.resolve();

    const subscribe = (socket: WebSocket) => {
      if (subscribed) return;
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'fastAssetCtxs' } }));
      socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      for (const dex of dexList) {
        socket.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', dex } }));
      }
      subscribed = true;
    };

    const stopTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (staleTimer) clearInterval(staleTimer);
      pingTimer = undefined;
      staleTimer = undefined;
    };

    const connect = () => {
      if (cancelled || document.hidden) return;
      subscribed = false;
      fastLive = false;
      decodeChain = Promise.resolve();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      stopTimers();
      if (ws && ws.readyState <= 1) {
        try {
          ws.onclose = null;
          ws.close();
        } catch {
          /* ignore */
        }
      }
      const socket = new WebSocket(HL_WS_URL);
      ws = socket;
      socket.onopen = () => {
        if (cancelled || ws !== socket) return;
        attempt = 0;
        lastMsgAt = Date.now();
        feed.lastMainAt = Date.now();
        subscribe(socket);
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: 'ping' }));
        }, PING_MS);
        staleTimer = setInterval(() => {
          if (document.hidden || ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          const now = Date.now();
          if (now - lastMsgAt > STALE_MS || (feed.lastMainAt > 0 && now - feed.lastMainAt > STALE_MS)) {
            socket.close();
          }
        }, 5_000);
      };
      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        lastMsgAt = Date.now();
        let msg: {
          channel?: string;
          data?: string | { mids?: Record<string, string>; dex?: string };
        };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.channel === 'fastAssetCtxs' && typeof msg.data === 'string') {
          const payload = msg.data;
          decodeChain = decodeChain
            .then(async () => {
              if (cancelled || ws !== socket) return;
              applyFastCtxs(await decodeFastAssetCtxs(payload));
              fastLive = true;
              feed.lastMainAt = Date.now();
            })
            .catch(() => {
              /* keep allMids fallback */
            });
          return;
        }
        if (fastLive) return;
        if (msg.channel !== 'allMids' || typeof msg.data !== 'object' || !msg.data?.mids) return;
        const dex = typeof msg.data.dex === 'string' && msg.data.dex ? msg.data.dex : null;
        if (!dex) feed.lastMainAt = Date.now();
        applyMids(msg.data.mids, dex);
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        stopTimers();
        if (cancelled || document.hidden) return;
        const wait = Math.min(8_000, 300 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = setTimeout(connect, wait);
      };
      socket.onerror = () => socket.close();
    };

    if (feed.snapshot.size === 0 && feed.pending.size === 0) void seedRest(dexList);

    const onVis = () => {
      if (document.hidden) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        stopTimers();
        if (ws && ws.readyState <= 1) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
        ws = null;
        return;
      }
      attempt = 0;
      connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopTimers();
      if (ws && ws.readyState <= 1) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [dexKey]);
}

const EMPTY_MIDS = new Map<string, number>();

function noopSubscribe() {
  return () => {};
}

function getEmptySnapshot() {
  return EMPTY_MIDS;
}

/** Live mid map. Pass `enabled` so only the open picker re-renders on flushes. */
export function useHlAllMids(enabled: boolean): Map<string, number> {
  return useSyncExternalStore(
    enabled ? subscribeStore : noopSubscribe,
    enabled ? getSnapshot : getEmptySnapshot,
    getEmptySnapshot,
  );
}

export function midFromAllMids(mids: Map<string, number>, coin: string): number | null {
  if (!coin || !mids.size) return null;
  const direct = mids.get(coin);
  if (direct != null && direct > 0) return direct;
  const dex = dexFromCoin(coin);
  const base = coin.includes(':') ? (coin.split(':').pop() as string) : coin;
  if (dex) {
    const keyed = mids.get(`${dex}:${base}`);
    if (keyed != null && keyed > 0) return keyed;
    return null;
  }
  const bare = mids.get(base) ?? mids.get(base.toUpperCase());
  if (bare != null && bare > 0) return bare;
  return null;
}
