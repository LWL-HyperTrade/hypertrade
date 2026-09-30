/**
 * Options positioning (BTC/ETH) — the slice of institutional options signal
 * CoinGlass Standard can actually serve. Everything strike-level (GEX/DEX,
 * OI walls, unusual flow, skew, term structure) needs book greeks or chains
 * that CoinGlass doesn't expose at any tier — deliberately NOT faked here.
 * (Future path to real skew/term structure: process Deribit's public chain.)
 *
 * What we compute, and why it survives the noise filter:
 *   • ΔOI 24h + volume/OI ratio (`/api/option/info`, "All" row) — is NEW
 *     options positioning entering, or is it a quiet book?
 *   • Premium-weighted put/call ratio (`/api/option/max-pain` per-expiry
 *     call/put OI *market values*, nearest expiries) — the 4-star "premium
 *     ratio", not the 2-star contract-count PCR. Max pain price itself is
 *     intentionally NOT rendered (weak signal at hours-to-days horizons).
 *
 * DVOL (Deribit, free) remains the IV level/change signal — this complements
 * it with positioning. Globally cached 1h; BTC/ETH only (same gate as DVOL).
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';
import { supportsDeribitDvol } from './deribit.js';
import { fmtUsd } from './etfFlows.js';

export interface OptionsPositioningContext {
  asset: string;
  oiUsd: number | null;
  oiChange24hPct: number | null;
  volumeUsd24h: number | null;
  /** 24h volume / OI — how much of the book turned over today. */
  volOiRatio: number | null;
  /** Put premium / call premium across the nearest expiries (value-weighted). */
  premiumPutCallRatio: number | null;
  updatedAt: string;
}

const TTL_MS = 60 * 60 * 1000;
const BASE = 'https://open-api-v4.coinglass.com';
/** Premium PCR window: nearest N expiries (dailies + the front weekly). */
const NEAR_EXPIRIES = 3;

async function cgJson<T>(path: string, apiKey: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'CG-API-KEY': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CoinGlass ${path} HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: T[] };
  if (body.code !== '0') throw new Error(`CoinGlass ${path}: ${body.msg ?? body.code}`);
  return body.data ?? [];
}

interface InfoRow {
  exchange_name?: string;
  open_interest_usd?: number | string;
  open_interest_change_24h?: number | string;
  volume_usd_24h?: number | string;
}

interface MaxPainRow {
  date?: string; // YYMMDD
  call_open_interest_market_value?: number | string;
  put_open_interest_market_value?: number | string;
}

async function produce(asset: string, apiKey: string): Promise<OptionsPositioningContext> {
  const [info, maxPain] = await Promise.all([
    cgJson<InfoRow>('/api/option/info', apiKey, { symbol: asset }).catch(() => [] as InfoRow[]),
    cgJson<MaxPainRow>('/api/option/max-pain', apiKey, { symbol: asset, exchange: 'Deribit' }).catch(
      () => [] as MaxPainRow[],
    ),
  ]);

  const all = info.find((r) => String(r.exchange_name ?? '').toLowerCase() === 'all') ?? info[0];
  const oiUsd = all ? Number(all.open_interest_usd) : NaN;
  const oiChg = all ? Number(all.open_interest_change_24h) : NaN;
  const vol24 = all ? Number(all.volume_usd_24h) : NaN;

  // Nearest expiries by date code (rows are per expiry; YYMMDD sorts lexically).
  const sorted = maxPain
    .filter((r) => typeof r.date === 'string' && r.date.length === 6)
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
    .slice(0, NEAR_EXPIRIES);
  let putVal = 0;
  let callVal = 0;
  for (const r of sorted) {
    const p = Number(r.put_open_interest_market_value);
    const c = Number(r.call_open_interest_market_value);
    if (Number.isFinite(p)) putVal += p;
    if (Number.isFinite(c)) callVal += c;
  }

  return {
    asset,
    oiUsd: Number.isFinite(oiUsd) ? oiUsd : null,
    oiChange24hPct: Number.isFinite(oiChg) ? oiChg : null,
    volumeUsd24h: Number.isFinite(vol24) ? vol24 : null,
    volOiRatio:
      Number.isFinite(vol24) && Number.isFinite(oiUsd) && oiUsd > 0 ? vol24 / oiUsd : null,
    premiumPutCallRatio: callVal > 0 ? putVal / callVal : null,
    updatedAt: new Date().toISOString(),
  };
}

export async function getOptionsPositioning(
  hlCoin: string,
): Promise<OptionsPositioningContext | null> {
  if (config.coinankMode) return null;
  const asset = hlCoin.toUpperCase();
  if (!supportsDeribitDvol(asset)) return null; // options markets = BTC/ETH only
  const key = config.coinglassHouseKey;
  if (!key) return null;
  return getOrRefreshGlobalContext<OptionsPositioningContext>({
    key: `options_positioning_${asset}`,
    ttlMs: TTL_MS,
    produce: () => produce(asset, key),
  });
}

/** ≤3-line prompt section. Empty for non-BTC/ETH or when data is missing. */
export function renderOptionsPositioningSection(
  ctx: OptionsPositioningContext | null | undefined,
): string {
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.oiUsd != null) {
    const chg =
      ctx.oiChange24hPct != null
        ? ` (${ctx.oiChange24hPct >= 0 ? '+' : ''}${ctx.oiChange24hPct.toFixed(1)}% 24h)`
        : '';
    const turnover =
      ctx.volOiRatio != null
        ? ` | 24h vol ${ctx.volumeUsd24h != null ? fmtUsd(ctx.volumeUsd24h).replace('+', '') : 'N/A'}, vol/OI ${ctx.volOiRatio.toFixed(2)}${ctx.volOiRatio >= 0.15 ? ' — ELEVATED new positioning' : ' — routine'}`
        : '';
    lines.push(`- Options OI: ${fmtUsd(ctx.oiUsd).replace('+', '')}${chg}${turnover}`);
  }
  if (ctx.premiumPutCallRatio != null) {
    const r = ctx.premiumPutCallRatio;
    const read =
      r >= 1.3 ? 'PUT-heavy (downside hedging/fear)' : r <= 0.7 ? 'CALL-heavy (upside chasing)' : 'balanced';
    lines.push(
      `- Near-expiry premium put/call: ${r.toFixed(2)} — ${read} (value-weighted, not contract counts)`,
    );
  }
  if (lines.length === 0) return '';
  return `

**OPTIONS POSITIONING (${ctx.asset}, Deribit-led — context, not a trigger)**:
${lines.join('\n')}`;
}
