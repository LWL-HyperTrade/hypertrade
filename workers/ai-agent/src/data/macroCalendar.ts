/**
 * Macro calendar — US public holidays + scheduled high-impact macro events,
 * globally cached, injected into prompts as a RELATIVE slice only.
 *
 * Design (per product decision 2026-07):
 *   • The FULL calendar lives in `global_context_cache` (key
 *     `macro_calendar_v1`, 7-day TTL — this data changes ~yearly).
 *   • Prompts NEVER see the full calendar. They get "today is <date>" plus at
 *     most the next few events within a 7-day lookahead, phrased relatively
 *     ("US CPI — Tuesday 2026-07-14 (in 3 days)"). No noise.
 *
 * Sources:
 *   • US holidays: Nager.Date public API (free, no key), fetched for the
 *     current + next year inside the cache producer. Best-effort — the seeded
 *     macro events below are returned even if the holiday fetch fails.
 *   • Macro events: seeded from PRIMARY sources (verified 2026-07-11):
 *       CPI  — BLS release schedule, 08:30 ET
 *              https://www.bls.gov/schedule/news_release/cpi.htm
 *       FOMC — Fed meeting calendar (decision = 2nd day, 14:00 ET)
 *              https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *     Extend SEEDED_MACRO_EVENTS when adding NFP/PPI or the next year's
 *     schedule (published each fall). Do NOT guess dates — wrong macro dates
 *     steering trades is worse than none.
 */
import { config } from '../config.js';
import { getOrRefreshGlobalContext } from '../lib/globalCache.js';

export interface CalendarEvent {
  /** ISO date, UTC day of the event. */
  date: string;
  label: string;
  kind: 'macro' | 'us_holiday';
  importance: 'high' | 'medium';
  /** Human time hint (ET is what desks quote; models handle the conversion). */
  timeNote?: string;
  /** Exact publish time (ms) when CoinGlass provides it — powers ≤2h print window. */
  publishAtMs?: number;
  /** Consensus forecast (from the economic-data API), e.g. "2.9%". */
  forecast?: string;
  /** Previous print, e.g. "3.1%". */
  previous?: string;
}

/**
 * Equity-relevant US macro names. Prefer these when rendering for stocks so
 * the ≤4-event cap isn't wasted on less actionable "importance 3" rows.
 */
const EQUITY_MACRO_PATTERNS: RegExp[] = [
  /\bcpi\b/i,
  /\bcore\s*cpi\b/i,
  /\bpce\b/i,
  /\bcore\s*pce\b/i,
  /\bfomc\b/i,
  /\bfederal\s*reserve\b/i,
  /\binterest\s*rate\b/i,
  /\bnonfarm\b/i,
  /\bnfp\b/i,
  /\bpayroll/i,
  /\bunemployment\b/i,
  /\bppi\b/i,
  /\bgdp\b/i,
  /\bretail\s*sales\b/i,
  /\bjolts\b/i,
];

function isEquityRelevantMacro(label: string): boolean {
  return EQUITY_MACRO_PATTERNS.some((re) => re.test(label));
}

export interface UpcomingCalendarEvent extends CalendarEvent {
  /** 0 = today, 1 = tomorrow, ... */
  daysUntil: number;
  /** Weekday name of the event date (UTC). */
  weekday: string;
}

/** BLS CPI 2026 release dates (all 08:30 ET). */
const CPI_2026 = [
  '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12',
  '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14',
  '2026-11-10', '2026-12-10',
];

/** FOMC 2026 decision days (2nd meeting day, statement 14:00 ET). */
const FOMC_2026 = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];

const SEEDED_MACRO_EVENTS: CalendarEvent[] = [
  ...CPI_2026.map((date) => ({
    date,
    label: 'US CPI (inflation) release',
    kind: 'macro' as const,
    importance: 'high' as const,
    timeNote: '08:30 ET',
  })),
  ...FOMC_2026.map((date) => ({
    date,
    label: 'FOMC rate decision',
    kind: 'macro' as const,
    importance: 'high' as const,
    timeNote: '14:00 ET statement, presser 14:30 ET',
  })),
];

interface NagerHoliday {
  date?: string;
  name?: string;
  localName?: string;
}

async function fetchUsHolidays(year: number): Promise<CalendarEvent[]> {
  const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/US`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Nager.Date HTTP ${res.status}`);
  const rows = (await res.json()) as NagerHoliday[];
  const out: CalendarEvent[] = [];
  for (const r of rows) {
    if (!r?.date || !r?.name) continue;
    out.push({
      date: r.date,
      label: `US public holiday: ${r.name}`,
      kind: 'us_holiday',
      importance: 'medium',
    });
  }
  return out;
}

/**
 * CoinGlass economic calendar (Startup+ plans) — live schedule with consensus
 * forecast + previous prints, ±15-day window. US high-impact only
 * (importance_level 3): that's what moves crypto; everything else is noise.
 * Fetched with the house key; when unavailable (BYOK mode / fetch failure)
 * the yearly seeded CPI/FOMC list below keeps the calendar functional.
 */
interface CgEconRow {
  calendar_name?: string;
  country_code?: string;
  importance_level?: number;
  publish_timestamp?: number;
  forecast_value?: string;
  previous_value?: string;
  has_exact_publish_time?: number;
}

async function fetchEconomicCalendar(apiKey: string): Promise<CalendarEvent[]> {
  const now = Date.now();
  const qs = new URLSearchParams({
    start_time: String(now - 24 * 60 * 60 * 1000),
    end_time: String(now + 14 * 24 * 60 * 60 * 1000),
    language: 'en',
  });
  const res = await fetch(
    `https://open-api-v4.coinglass.com/api/calendar/economic-data?${qs}`,
    { headers: { 'CG-API-KEY': apiKey, accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`CoinGlass economic-data HTTP ${res.status}`);
  const body = (await res.json()) as { code?: string; msg?: string; data?: CgEconRow[] };
  if (body.code !== '0') throw new Error(`CoinGlass economic-data: ${body.msg ?? body.code}`);

  const out: CalendarEvent[] = [];
  for (const r of body.data ?? []) {
    if (r.country_code !== 'US' || r.importance_level !== 3) continue;
    const ts = Number(r.publish_timestamp);
    const name = (r.calendar_name ?? '').trim();
    if (!Number.isFinite(ts) || !name) continue;
    const when = new Date(ts);
    out.push({
      date: when.toISOString().slice(0, 10),
      label: `US: ${name}`,
      kind: 'macro',
      importance: 'high',
      publishAtMs: r.has_exact_publish_time === 1 ? ts : undefined,
      timeNote:
        r.has_exact_publish_time === 1
          ? `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')} UTC`
          : undefined,
      forecast: (r.forecast_value ?? '').trim() || undefined,
      previous: (r.previous_value ?? '').trim() || undefined,
    });
  }
  return out;
}

// 12h TTL: cheap to rebuild (1 econ GET + 2 free holiday GETs) and keeps
// forecast values fresh; seeds-only fallback rebuilds just as cheaply.
const CALENDAR_TTL_MS = 12 * 60 * 60 * 1000;

async function produceCalendar(): Promise<CalendarEvent[]> {
  const year = new Date().getUTCFullYear();
  let holidays: CalendarEvent[] = [];
  try {
    const [a, b] = await Promise.all([fetchUsHolidays(year), fetchUsHolidays(year + 1)]);
    holidays = [...a, ...b];
  } catch (err) {
    console.warn('[macroCalendar] holiday fetch failed (seeded events still served):',
      err instanceof Error ? err.message : err);
  }

  let macro: CalendarEvent[] = [];
  const key = config.coinankMode ? null : config.coinglassHouseKey;
  if (key) {
    try {
      macro = await fetchEconomicCalendar(key);
    } catch (err) {
      console.warn('[macroCalendar] economic-data fetch failed (falling back to seeds):',
        err instanceof Error ? err.message : err);
    }
  }
  if (macro.length === 0) macro = SEEDED_MACRO_EVENTS;

  return [...macro, ...holidays].sort((x, y) => x.date.localeCompare(y.date));
}

/** Per-process memo so per-agent calls within a cycle don't re-hit Supabase. */
let memo: { at: number; events: CalendarEvent[] } | null = null;
const MEMO_TTL_MS = 5 * 60 * 1000;

async function getFullCalendar(): Promise<CalendarEvent[]> {
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.events;
  const events =
    (await getOrRefreshGlobalContext<CalendarEvent[]>({
      key: config.coinankMode ? 'macro_calendar_seeded_v1' : 'macro_calendar_v2',
      ttlMs: CALENDAR_TTL_MS,
      produce: produceCalendar,
    })) ?? SEEDED_MACRO_EVENTS;
  memo = { at: Date.now(), events };
  return events;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function utcDayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/**
 * The relative slice for prompts: events from today through `lookaheadDays`,
 * high-importance macro first. Default cap is generous so equity allowlist
 * filtering at render time still has candidates; prompts always re-cap to ≤4.
 */
export async function getUpcomingCalendarEvents(
  now: Date = new Date(),
  lookaheadDays = 7,
  maxEvents = 12,
): Promise<UpcomingCalendarEvent[]> {
  const events = await getFullCalendar();
  const todayIso = now.toISOString().slice(0, 10);
  const today = utcDayNumber(todayIso);

  const upcoming: UpcomingCalendarEvent[] = [];
  for (const e of events) {
    const day = utcDayNumber(e.date);
    if (!Number.isFinite(day)) continue;
    const daysUntil = day - today;
    if (daysUntil < 0 || daysUntil > lookaheadDays) continue;
    upcoming.push({
      ...e,
      daysUntil,
      weekday: WEEKDAYS[new Date(`${e.date}T00:00:00Z`).getUTCDay()],
    });
  }
  upcoming.sort(
    (a, b) =>
      (a.importance === b.importance ? 0 : a.importance === 'high' ? -1 : 1) ||
      a.daysUntil - b.daysUntil,
  );
  return upcoming.slice(0, maxEvents).sort((a, b) => a.daysUntil - b.daysUntil);
}

function relativeText(daysUntil: number): string {
  if (daysUntil === 0) return 'TODAY';
  if (daysUntil === 1) return 'TOMORROW';
  return `in ${daysUntil} days`;
}

/** Prefer equity-moving prints, then fill with other high-impact / holidays. Cap ≤4. */
function selectEventsForPrompt(
  events: UpcomingCalendarEvent[],
  forEquity: boolean,
  maxEvents = 4,
): UpcomingCalendarEvent[] {
  if (!forEquity || events.length === 0) {
    return events.slice(0, maxEvents);
  }
  const preferred = events.filter(
    (e) => e.kind === 'macro' && e.importance === 'high' && isEquityRelevantMacro(e.label),
  );
  const rest = events.filter((e) => !preferred.includes(e));
  return [...preferred, ...rest].slice(0, maxEvents);
}

/** True when a HIGH macro print is today and 0–2h away (needs publishAtMs). */
function isWithinPrintWindow(e: UpcomingCalendarEvent, now: Date, hours = 2): boolean {
  if (e.importance !== 'high' || e.kind !== 'macro' || e.daysUntil !== 0) return false;
  if (e.publishAtMs == null) return false;
  const delta = e.publishAtMs - now.getTime();
  return delta >= 0 && delta <= hours * 3_600_000;
}

/**
 * Compact calendar block shared by all prompts. Always renders the current
 * date line; event lines only when something is inside the lookahead window.
 */
export function renderCalendarSection(
  events: UpcomingCalendarEvent[] | null | undefined,
  now: Date = new Date(),
  opts?: { aggressive?: boolean; forEquity?: boolean },
): string {
  const todayIso = now.toISOString().slice(0, 10);
  const weekday = WEEKDAYS[now.getUTCDay()];
  const lines: string[] = [`- Today's Date: **${weekday}, ${todayIso}** (UTC)`];

  const list = selectEventsForPrompt(events ?? [], !!opts?.forEquity);
  if (list.length === 0) {
    lines.push(
      opts?.forEquity
        ? '- No equity-relevant high-impact US macro (CPI/PCE/FOMC/NFP/PPI/GDP/…) or US holidays in the next 7 days'
        : '- No scheduled high-impact macro events or US holidays in the next 7 days',
    );
  } else {
    for (const e of list) {
      const mark = e.importance === 'high' ? '⚠️ HIGH' : 'Note';
      const time = e.timeNote ? `, ${e.timeNote}` : '';
      const consensus =
        e.forecast || e.previous
          ? ` [${e.forecast ? `forecast ${e.forecast}` : ''}${e.forecast && e.previous ? ' vs ' : ''}${e.previous ? `prev ${e.previous}` : ''}]`
          : '';
      lines.push(`- ${mark}: ${e.label} — ${e.weekday} ${e.date} (${relativeText(e.daysUntil)}${time})${consensus}`);
    }
    const printSoon = list.find((e) => isWithinPrintWindow(e, now));
    if (printSoon) {
      lines.push(
        `- ⚠️ PRINT WINDOW (≤2h): ${printSoon.label} releases soon — expect gap/whipsaw; prefer probe size or FLAT for NEW entries; protect open positions.`,
      );
    }
    const hasNearHigh = list.some((e) => e.importance === 'high' && e.daysUntil <= 1);
    if (hasNearHigh) {
      lines.push(
        opts?.aggressive
          ? '- ⚠️ EVENT RISK RULE: a HIGH-impact release is within ~24h. Reduce NEW-entry size by one band (probe tier allowed — small positions into events are acceptable when the thesis does not depend on the print), protect open positions (tighter stops / breakeven), and expect a volatility expansion + possible whipsaw at release. Do not pre-position FULL size on a guess about the print — sidelining is not required.'
          : '- ⚠️ EVENT RISK RULE: a HIGH-impact release is within ~24h. Prefer smaller size or FLAT for new entries, protect open positions (tighter stops / breakeven), and expect a volatility expansion + possible whipsaw at release. Do not pre-position on a guess about the print.',
      );
    }
  }

  return `

**CALENDAR CONTEXT**:
${lines.join('\n')}`;
}
