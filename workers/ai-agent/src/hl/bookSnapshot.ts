/**
 * L2 order-book snapshot helpers — pure functions over one HL `l2Book` reply.
 *
 * Purpose (2026-09): replace the static liquidity-tier slippage table and
 * blind IOC opens with a *measured* read of the book at decision/execution
 * time. This is a REST snapshot per symbol per cycle (weight 2), NOT a
 * streaming microstructure engine — it answers "is the book good enough for
 * this size right now", not "is this the right 200ms to enter".
 *
 * Nothing here talks to the network: the adapter fetches, this file parses,
 * scores, renders. Keep it that way so it stays unit-testable.
 */

export interface BookLevel {
  px: number;
  sz: number;
  /** Resting orders at this level. */
  n: number;
}

export interface BookSnapshot {
  symbol: string;
  /** HL snapshot time (ms). */
  time: number;
  /** Local wall-clock when we received it (ms). */
  fetchedAt: number;
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadBps: number;
  /** (bid$ − ask$) / (bid$ + ask$) over the top 5 levels each side; +1 = all bids. */
  imbalanceTop5: number;
  /** Resting notional within ±10 bps of mid (HL returns ≤20 levels/side). */
  bidUsd10bps: number;
  askUsd10bps: number;
  /** Resting notional within ±50 bps of mid (top-20 levels cap applies). */
  bidUsd50bps: number;
  askUsd50bps: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

type RawLevel = { px: string | number; sz: string | number; n?: number };
type RawBook =
  | {
      coin?: string;
      time?: number;
      levels?: [RawLevel[], RawLevel[]] | RawLevel[][];
    }
  | null
  | undefined;

function toLevels(raw: RawLevel[] | undefined): BookLevel[] {
  const out: BookLevel[] = [];
  for (const l of raw ?? []) {
    const px = Number(l?.px);
    const sz = Number(l?.sz);
    if (!(px > 0) || !(sz > 0)) continue;
    out.push({ px, sz, n: Number(l?.n ?? 0) || 0 });
  }
  return out;
}

function usdWithin(levels: BookLevel[], mid: number, bandFrac: number): number {
  let usd = 0;
  for (const l of levels) {
    if (Math.abs(l.px - mid) / mid > bandFrac) break;
    usd += l.px * l.sz;
  }
  return usd;
}

/** Parse one `l2Book` response. Returns null when either side is empty. */
export function parseL2Book(symbol: string, raw: RawBook, now = Date.now()): BookSnapshot | null {
  const levels = raw?.levels;
  if (!levels || !Array.isArray(levels) || levels.length < 2) return null;
  // Bids best-first (descending px), asks best-first (ascending px).
  const bids = toLevels(levels[0] as RawLevel[]).sort((a, b) => b.px - a.px);
  const asks = toLevels(levels[1] as RawLevel[]).sort((a, b) => a.px - b.px);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0].px;
  const bestAsk = asks[0].px;
  if (!(bestAsk > bestBid)) return null; // crossed / garbage
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  const top = (ls: BookLevel[]) => ls.slice(0, 5).reduce((s, l) => s + l.px * l.sz, 0);
  const bidTop = top(bids);
  const askTop = top(asks);
  const imbalanceTop5 = bidTop + askTop > 0 ? (bidTop - askTop) / (bidTop + askTop) : 0;

  return {
    symbol: symbol.toUpperCase(),
    time: Number(raw?.time ?? now) || now,
    fetchedAt: now,
    bestBid,
    bestAsk,
    mid,
    spreadBps,
    imbalanceTop5,
    bidUsd10bps: usdWithin(bids, mid, 0.001),
    askUsd10bps: usdWithin(asks, mid, 0.001),
    bidUsd50bps: usdWithin(bids, mid, 0.005),
    askUsd50bps: usdWithin(asks, mid, 0.005),
    bids,
    asks,
  };
}

export type TakeSide = 'buy' | 'sell';

export interface SweepEstimate {
  /** Notional fillable at or inside `maxSlipFrac` of mid. */
  fillableUsd: number;
  /** True when the whole `sizeUsd` fits inside `maxSlipFrac`. */
  fullyFillable: boolean;
  /** Slippage (fraction of mid, ≥ 0) of the worst level needed; null if not fully fillable. */
  worstSlipFrac: number | null;
  /** VWAP slippage of the filled part (fraction of mid, ≥ 0); null if nothing fills. */
  vwapSlipFrac: number | null;
  /** Levels consumed (fully or partially). */
  levelsUsed: number;
}

/**
 * Walk the taking side of the book for `sizeUsd` notional. Buy consumes asks
 * (prices rising), sell consumes bids (prices falling). Levels beyond
 * `maxSlipFrac` from mid are ignored — that is the caller's hard ceiling.
 */
export function estimateSweep(
  book: BookSnapshot,
  side: TakeSide,
  sizeUsd: number,
  maxSlipFrac: number,
): SweepEstimate {
  const levels = side === 'buy' ? book.asks : book.bids;
  const mid = book.mid;
  let remaining = Math.max(0, sizeUsd);
  let filledUsd = 0;
  let filledUnits = 0;
  let worst: number | null = null;
  let levelsUsed = 0;
  for (const l of levels) {
    if (remaining <= 1e-9) break;
    const slip = Math.abs(l.px - mid) / mid;
    if (slip > maxSlipFrac) break;
    const levelUsd = l.px * l.sz;
    const take = Math.min(levelUsd, remaining);
    filledUsd += take;
    filledUnits += take / l.px;
    remaining -= take;
    worst = slip;
    levelsUsed += 1;
  }
  const fullyFillable = sizeUsd > 0 && remaining <= 1e-6 * Math.max(1, sizeUsd);
  const vwap = filledUnits > 0 ? filledUsd / filledUnits : null;
  return {
    fillableUsd: filledUsd,
    fullyFillable,
    worstSlipFrac: fullyFillable ? worst : null,
    vwapSlipFrac: vwap != null ? Math.abs(vwap - mid) / mid : null,
    levelsUsed,
  };
}

export interface BookGateOptions {
  /** Skip when the spread is wider than this (bps). */
  maxSpreadBps: number;
  /** Taking-side depth within ±50 bps must be ≥ this × order size. */
  minDepthMult: number;
  /** Hard IOC ceiling — if the size does not fit inside this, skip. */
  maxSlipFrac: number;
}

export interface BookGateResult {
  ok: boolean;
  reason: string | null;
  spreadBps: number;
  takeSideDepthUsd50bps: number;
  depthMult: number;
  sweep: SweepEstimate;
}

/**
 * Execution-quality gate for a fresh open. Purely about whether the book can
 * absorb `sizeUsd` sanely — never a directional signal. Closes must NOT be
 * gated (exiting matters more than saving bps).
 */
export function assessBookForOpen(
  book: BookSnapshot,
  side: TakeSide,
  sizeUsd: number,
  opts: BookGateOptions,
): BookGateResult {
  const sweep = estimateSweep(book, side, sizeUsd, opts.maxSlipFrac);
  const depth = side === 'buy' ? book.askUsd50bps : book.bidUsd50bps;
  const depthMult = sizeUsd > 0 ? depth / sizeUsd : Infinity;
  let reason: string | null = null;
  if (book.spreadBps > opts.maxSpreadBps) {
    reason = `spread ${book.spreadBps.toFixed(1)} bps > ${opts.maxSpreadBps} bps limit`;
  } else if (!sweep.fullyFillable) {
    reason = `only $${Math.round(sweep.fillableUsd)} of $${Math.round(sizeUsd)} fillable within ${(opts.maxSlipFrac * 100).toFixed(1)}%`;
  } else if (depthMult < opts.minDepthMult) {
    reason = `${side === 'buy' ? 'ask' : 'bid'} depth $${Math.round(depth)} within 50 bps < ${opts.minDepthMult}× order ($${Math.round(sizeUsd)})`;
  }
  return {
    ok: reason == null,
    reason,
    spreadBps: book.spreadBps,
    takeSideDepthUsd50bps: depth,
    depthMult,
    sweep,
  };
}

/** Flat jsonb-friendly fields for decision rows / signal snapshots. */
export function bookLogFields(
  book: BookSnapshot | null | undefined,
  gate?: BookGateResult | null,
): Record<string, unknown> {
  if (!book) return { book: null };
  const round = (v: number, d = 2) => Number(v.toFixed(d));
  return {
    book: {
      ageSec: round(Math.max(0, (book.fetchedAt - book.time) / 1000), 1),
      mid: book.mid,
      spreadBps: round(book.spreadBps),
      imbalanceTop5: round(book.imbalanceTop5, 3),
      bidUsd10bps: Math.round(book.bidUsd10bps),
      askUsd10bps: Math.round(book.askUsd10bps),
      bidUsd50bps: Math.round(book.bidUsd50bps),
      askUsd50bps: Math.round(book.askUsd50bps),
      ...(gate
        ? {
            gateOk: gate.ok,
            gateReason: gate.reason,
            depthMult: Number.isFinite(gate.depthMult) ? round(gate.depthMult, 1) : null,
            sweepWorstBps:
              gate.sweep.worstSlipFrac != null ? round(gate.sweep.worstSlipFrac * 10_000, 1) : null,
            sweepVwapBps:
              gate.sweep.vwapSlipFrac != null ? round(gate.sweep.vwapSlipFrac * 10_000, 1) : null,
          }
        : {}),
    },
  };
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

/**
 * Opening-prompt block. Two or three lines: execution-quality context the
 * model can use for SIZE and patience. Explicitly told it is not a thesis.
 */
export function renderBookSection(book: BookSnapshot | null | undefined): string {
  if (!book) return '';
  const imb = book.imbalanceTop5;
  const imbLabel =
    imb > 0.25 ? 'bid-heavy' : imb < -0.25 ? 'ask-heavy' : 'balanced';
  const ageSec = Math.max(0, Math.round((Date.now() - book.fetchedAt) / 1000));
  const thin =
    book.spreadBps > 20 || Math.min(book.bidUsd10bps, book.askUsd10bps) < 25_000;
  const note = thin
    ? '\n- Book is THIN / wide for this venue right now: keep size at the low end of the band and expect slippage; prefer patience over chasing.'
    : '';
  return `

**LIVE HL BOOK** (L2 snapshot, ${ageSec}s old — execution context, NOT a directional thesis):
- Spread ${book.spreadBps.toFixed(1)} bps · mid $${book.mid >= 100 ? book.mid.toFixed(2) : book.mid.toPrecision(5)} · top-5 imbalance ${imb >= 0 ? '+' : ''}${imb.toFixed(2)} (${imbLabel})
- Resting depth (top-20 levels/side) within ±10 bps: bids ${fmtUsd(book.bidUsd10bps)} / asks ${fmtUsd(book.askUsd10bps)} · within ±50 bps: ${fmtUsd(book.bidUsd50bps)} / ${fmtUsd(book.askUsd50bps)}${note}`;
}
