/**
 * Signal snapshots + forward outcomes (`ai_signal_snapshots`).
 *
 * Why: the composite score's 30/30/20/10/10 weights and every flag threshold
 * are hand-set. Nothing in the worker recorded what the market did AFTER a
 * given flag state, so there was no way to check whether any of it predicts
 * anything at the horizons we trade. This module writes one row per
 * symbol × bar interval × horizon per cycle (flags, score, HL mid, book) and
 * back-fills 1h / 4h / 24h forward returns plus max favorable / adverse
 * excursion from the CoinGlass bars on later cycles.
 *
 * Returns are BAR-to-BAR (CoinGlass aggregated close → close) so the basis
 * is consistent; the HL mid is stored alongside for reference only.
 *
 * Zero trade impact: writes are fire-and-forget and gated by
 * SIGNAL_SNAPSHOTS_ENABLED. Schema: backend/migrations/ai_signal_snapshots.sql.
 */
import type { CompositeScore, FuturesBar, ScalperFlags } from '../brain/computeScalperFlags.js';
import type { Horizon } from '../brain/horizon.js';
import { config } from '../config.js';
import type { MarketDataCache } from '../data/marketCache.js';
import { marketDataCacheKey } from '../data/marketCache.js';
import type { BookSnapshot } from '../hl/bookSnapshot.js';
import { bookLogFields } from '../hl/bookSnapshot.js';
import { getSupabase } from './supabase.js';

const TABLE = 'ai_signal_snapshots';
const HOUR_MS = 60 * 60 * 1000;
/** Only back-fill rows this recent — older unfilled rows (symbol dropped) stay as-is. */
const BACKFILL_LOOKBACK_MS = 3 * 24 * HOUR_MS;
const BACKFILL_BATCH = 400;
/** A forward bar counts as closed once this much time passed after its window. */
const BAR_CLOSE_GRACE_MS = 60_000;

const HORIZONS_MS = { ret_1h: 1 * HOUR_MS, ret_4h: 4 * HOUR_MS, ret_24h: 24 * HOUR_MS } as const;

/** In-process dedupe: many agents share a symbol; one row per key per cycle. */
const writtenThisCycle = new Set<string>();

export function resetSignalSnapshotCycle(): void {
  writtenThisCycle.clear();
}

export interface SignalSnapshotInput {
  /** Cycle boundary (floor to the opening window) — ms epoch. */
  cycleTs: number;
  symbol: string;
  barIntervalMs: number;
  horizon: Horizon;
  tradingEnv: 'mainnet' | 'demo';
  /** Price fed to the decision (HL mid, or bar close when HL was unavailable). */
  price: number;
  priceSource: 'hl_mid' | 'bar_close';
  /** Open timestamp (ms) of the last CLOSED bar and its close — return basis. */
  barCloseTs: number;
  barClose: number;
  flags: ScalperFlags;
  score: CompositeScore;
  book: BookSnapshot | null;
}

function intervalLabel(ms: number): string {
  return ms === 30 * 60 * 1000 ? '30m' : '1h';
}

/** Fire-and-forget insert (idempotent on the natural key). Never throws. */
export async function recordSignalSnapshot(input: SignalSnapshotInput): Promise<void> {
  if (!config.signalSnapshotsEnabled) return;
  const interval = intervalLabel(input.barIntervalMs);
  const key = `${input.cycleTs}|${input.symbol.toUpperCase()}|${interval}|${input.horizon}|${input.tradingEnv}`;
  if (writtenThisCycle.has(key)) return;
  writtenThisCycle.add(key);
  if (!(input.barClose > 0) || !Number.isFinite(input.barCloseTs)) return;

  try {
    const { error } = await getSupabase()
      .from(TABLE)
      .upsert(
        {
          cycle_ts: new Date(input.cycleTs).toISOString(),
          symbol: input.symbol.toUpperCase(),
          bar_interval: interval,
          horizon: input.horizon,
          trading_env: input.tradingEnv,
          price: input.price,
          price_source: input.priceSource,
          bar_close_ts: new Date(input.barCloseTs).toISOString(),
          bar_close: input.barClose,
          long_score: input.score.longScore,
          short_score: input.score.shortScore,
          drivers_long: input.score.driversLong,
          drivers_short: input.score.driversShort,
          flags: input.flags,
          book: (bookLogFields(input.book).book as Record<string, unknown> | null) ?? null,
        },
        { onConflict: 'cycle_ts,symbol,bar_interval,horizon,trading_env', ignoreDuplicates: true },
      );
    if (error) {
      // Common cause: migration not applied yet. Log once per cycle key, don't spam.
      console.warn(`[signals] snapshot write failed (${input.symbol}): ${error.message}`);
      writtenThisCycle.delete(key);
    }
  } catch (err) {
    console.warn('[signals] snapshot write error:', err instanceof Error ? err.message : err);
  }
}

interface PendingRow {
  id: number;
  symbol: string;
  bar_interval: string;
  bar_close_ts: string;
  bar_close: number | string;
  ret_1h: number | null;
  ret_4h: number | null;
  ret_24h: number | null;
}

export interface OutcomePatch {
  ret_1h?: number;
  ret_4h?: number;
  ret_24h?: number;
  max_up_4h?: number;
  max_down_4h?: number;
  max_up_24h?: number;
  max_down_24h?: number;
  outcomes_filled_at?: string;
}

function barMsOf(label: string): number {
  return label === '30m' ? 30 * 60 * 1000 : HOUR_MS;
}

/**
 * Pure: compute whichever forward outcomes are resolvable from `bars` for a
 * snapshot whose last closed bar opened at `t0` with close `p0`. A horizon is
 * only filled once its target bar has closed (target + barMs + grace ≤ now).
 * Exported for tests.
 */
export function computeForwardOutcomes(args: {
  bars: FuturesBar[];
  t0: number;
  p0: number;
  barMs: number;
  already: { ret_1h: number | null; ret_4h: number | null; ret_24h: number | null };
  now?: number;
}): OutcomePatch {
  const now = args.now ?? Date.now();
  const patch: OutcomePatch = {};
  if (!(args.p0 > 0)) return patch;
  const bars = [...args.bars]
    .filter((b) => Number.isFinite(b?.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!bars.length) return patch;

  const closeAt = (target: number): number | null => {
    // Exact bar preferred; tolerate a bar that opened within one interval
    // before the target (venue timestamps occasionally drift by seconds).
    let best: FuturesBar | null = null;
    for (const b of bars) {
      if (b.timestamp > target) break;
      if (b.timestamp >= target - args.barMs) best = b;
    }
    const px = best?.close_price;
    return Number.isFinite(px as number) && (px as number) > 0 ? (px as number) : null;
  };

  const excursion = (target: number): { up: number; down: number } | null => {
    let hi = -Infinity;
    let lo = Infinity;
    let n = 0;
    for (const b of bars) {
      if (b.timestamp <= args.t0) continue;
      if (b.timestamp > target) break;
      const h = Number.isFinite(b.high_price as number) ? (b.high_price as number) : (b.close_price as number);
      const l = Number.isFinite(b.low_price as number) ? (b.low_price as number) : (b.close_price as number);
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
      hi = Math.max(hi, h);
      lo = Math.min(lo, l);
      n += 1;
    }
    if (!n) return null;
    return { up: hi / args.p0 - 1, down: lo / args.p0 - 1 };
  };

  for (const [field, hMs] of Object.entries(HORIZONS_MS) as Array<[keyof typeof HORIZONS_MS, number]>) {
    if (args.already[field] != null) continue;
    const target = args.t0 + hMs;
    if (now < target + args.barMs + BAR_CLOSE_GRACE_MS) continue;
    const px = closeAt(target);
    if (px == null) continue;
    patch[field] = px / args.p0 - 1;
    if (field === 'ret_4h' || field === 'ret_24h') {
      const ex = excursion(target);
      if (ex) {
        if (field === 'ret_4h') {
          patch.max_up_4h = ex.up;
          patch.max_down_4h = ex.down;
        } else {
          patch.max_up_24h = ex.up;
          patch.max_down_24h = ex.down;
        }
      }
    }
  }
  if (patch.ret_24h != null) patch.outcomes_filled_at = new Date(now).toISOString();
  return patch;
}

/**
 * Cycle hook (after Phase 1): fill forward returns for recent snapshots using
 * the bar series already fetched this cycle. Symbols no longer traded by any
 * agent simply stay unfilled. Never throws.
 */
export async function backfillSignalOutcomes(marketData: MarketDataCache): Promise<{
  scanned: number;
  updated: number;
}> {
  if (!config.signalSnapshotsEnabled) return { scanned: 0, updated: 0 };
  const now = Date.now();
  let rows: PendingRow[] = [];
  try {
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select('id, symbol, bar_interval, bar_close_ts, bar_close, ret_1h, ret_4h, ret_24h')
      .is('ret_24h', null)
      .gte('cycle_ts', new Date(now - BACKFILL_LOOKBACK_MS).toISOString())
      .lte('cycle_ts', new Date(now - HOUR_MS).toISOString())
      .order('cycle_ts', { ascending: true })
      .limit(BACKFILL_BATCH);
    if (error) {
      console.warn(`[signals] backfill query failed: ${error.message}`);
      return { scanned: 0, updated: 0 };
    }
    rows = (data ?? []) as PendingRow[];
  } catch (err) {
    console.warn('[signals] backfill query error:', err instanceof Error ? err.message : err);
    return { scanned: 0, updated: 0 };
  }
  if (!rows.length) return { scanned: 0, updated: 0 };

  const seriesFor = (symbol: string, interval: string) => {
    const exact = marketData.get(marketDataCacheKey(symbol, interval === '30m' ? '30m' : '1h'));
    if (exact) return { data: exact, barMs: barMsOf(interval) };
    const other = marketData.get(marketDataCacheKey(symbol, interval === '30m' ? '1h' : '30m'));
    if (other) return { data: other, barMs: other.barIntervalMs ?? HOUR_MS };
    return null;
  };

  let updated = 0;
  const CHUNK = 20;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        const series = seriesFor(row.symbol, row.bar_interval);
        if (!series) return;
        const t0 = Date.parse(row.bar_close_ts);
        const p0 = Number(row.bar_close);
        if (!Number.isFinite(t0) || !(p0 > 0)) return;
        const patch = computeForwardOutcomes({
          bars: series.data.futures?.timeSeries ?? [],
          t0,
          p0,
          barMs: series.barMs,
          already: { ret_1h: row.ret_1h, ret_4h: row.ret_4h, ret_24h: row.ret_24h },
          now,
        });
        if (!Object.keys(patch).length) return;
        const { error } = await getSupabase().from(TABLE).update(patch).eq('id', row.id);
        if (error) {
          console.warn(`[signals] backfill update failed (${row.symbol}#${row.id}): ${error.message}`);
          return;
        }
        updated += 1;
      }),
    );
  }
  return { scanned: rows.length, updated };
}
