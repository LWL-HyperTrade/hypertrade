/**
 * CoinGlass /api/futures/rsi/list — multi-TF RSI for listed coins.
 * One global fetch (~30 min TTL), resolve per crypto coin at prompt time.
 * Fields verified 2026-08-09: rsi_15m / 1h / 4h / 12h / 24h / 1w.
 * We surface 1h / 4h / 24h (as "1d") — no local RSI fallback needed.
 */
import { config } from '../config.js';
import { coinPart } from '../brain/assetClass.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

const PATH = '/api/futures/rsi/list';
const TTL_MS = 30 * 60 * 1000;

export interface RsiRow {
  symbol: string;
  rsi1h: number | null;
  rsi4h: number | null;
  /** CoinGlass rsi_24h — treated as the 1d reading in prompts. */
  rsi1d: number | null;
  rsi1w: number | null;
}

export interface RsiContext {
  symbol: string;
  cgSymbol: string;
  rsi1h: number | null;
  rsi4h: number | null;
  rsi1d: number | null;
  rsi1w: number | null;
}

interface RawRsi {
  symbol?: string;
  rsi_1h?: number | string;
  rsi_4h?: number | string;
  rsi_24h?: number | string;
  rsi_1w?: number | string;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRow(r: RawRsi): RsiRow | null {
  const symbol = String(r.symbol ?? '').toUpperCase();
  if (!symbol) return null;
  return {
    symbol,
    rsi1h: num(r.rsi_1h),
    rsi4h: num(r.rsi_4h),
    rsi1d: num(r.rsi_24h),
    rsi1w: num(r.rsi_1w),
  };
}

async function produce(apiKey: string): Promise<Record<string, RsiRow>> {
  const res = await fetch(`https://open-api-v4.coinglass.com${PATH}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${PATH} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: RawRsi[] };
  if (body.code !== '0') throw new Error(`CoinGlass ${PATH}: ${body.msg ?? body.code}`);
  const out: Record<string, RsiRow> = {};
  for (const raw of body.data ?? []) {
    const row = toRow(raw);
    if (row) out[row.symbol] = row;
  }
  return out;
}

async function getRsiMap(): Promise<Record<string, RsiRow> | null> {
  const key = config.coinglassHouseKey;
  if (!key) return null;
  return getOrRefreshGlobalContext({
    key: 'coinglass_rsi_list_v1',
    ttlMs: TTL_MS,
    produce: () => produce(key),
  });
}

export async function getRsiContext(hlCoin: string): Promise<RsiContext | null> {
  if (config.coinankMode) return null;
  const map = await getRsiMap();
  if (!map) return null;
  const display = coinPart(hlCoin);
  const row = map[display];
  if (!row) return null;
  return {
    symbol: display,
    cgSymbol: row.symbol,
    rsi1h: row.rsi1h,
    rsi4h: row.rsi4h,
    rsi1d: row.rsi1d,
    rsi1w: row.rsi1w,
  };
}
