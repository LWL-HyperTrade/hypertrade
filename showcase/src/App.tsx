import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchShowcaseAgents,
  type ShowcaseAgent,
  type Side,
} from './api';
import { EquityChart } from './components/EquityChart';
import { FaqAccordion } from './components/FaqAccordion';
import { HorizonHint } from './components/HorizonHint';
import { Sparkline } from './components/Sparkline';
import { ClockIcon, ExternalLinkIcon, GitHubIcon, GooglePlayIcon, MailIcon, MediumIcon } from './components/Icons';
import { SHOWCASE_FAQ } from './lib/faq';
import { formatCycleCountdown, msUntilNextHourlyCycle } from './lib/hourlyCycle';
import { symbolLogoSrc } from './lib/symbolLogos';
import './styles.css';

const PLAY =
  'https://play.google.com/store/apps/details?id=com.hypertrade.app';
const MEDIUM =
  'https://medium.com/@lunaticwisdomlabs/building-ai-that-trades-with-you-a49c6b939bd0';
const GITHUB_AI_AGENT =
  'https://github.com/LWL-HyperTrade/hypertrade/tree/main/workers/ai-agent';
const CONTACT = 'mailto:support@hypertrade.exchange';
/** Align with showcase API cache (~28s) — snappier than 60s, still HL-friendly. */
const REFRESH_MS = 30_000;

/** House-agent → Hyperdash explorer (read-only). */
const HYPERDASH_BY_AGENT_ID: Record<string, string> = {
  '2369e222-c2c4-447b-aca1-5dc7e30f6cfb':
    'https://hyperdash.com/address/0x7fac31326e7df6b885b40a080a71e3bd42fce3a0',
  'fd6a5783-d0ce-4bf5-8214-aa166eb739f4':
    'https://hyperdash.com/address/0xe61c5487784345d79b1f379d148993d4cda8bd73',
  '682a3cea-0574-47dd-82c1-76d914c4597a':
    'https://hyperdash.com/address/0x3a73575a5501ace4f4048491c17189e22f4de734',
  '282b73a1-1a6d-447c-bf8a-4d4803e41ccf':
    'https://hyperdash.com/address/0xcbb222d6eca1abe22362d148ecf06a1f7b209f18',
  'f2501883-89ef-499b-8ea1-b6b56dd6f024':
    'https://hyperdash.com/address/0x8ea6a20ee4bd9a36da4eb5df981357b65db28c99',
  '03eab1e4-187e-4026-8a73-772aac296b3c':
    'https://hyperdash.com/address/0xdc2724db51987a86a7ce800ae54acfa1aa5338fb',
};

/** API equity is always `$1000 + dollar PnL`. Percents / chart labels use this map. */
const API_EQUITY_BASELINE_USD = 1000;
const DEFAULT_STARTING_CAPITAL_USD = 1000;
const STARTING_CAPITAL_USD_BY_AGENT_ID: Record<string, number> = {
  'f2501883-89ef-499b-8ea1-b6b56dd6f024': 10_000,
};

function hyperdashUrlFor(id: string): string | undefined {
  return HYPERDASH_BY_AGENT_ID[id.toLowerCase()];
}

function startingCapitalUsdFor(id: string): number {
  return STARTING_CAPITAL_USD_BY_AGENT_ID[id.toLowerCase()] ?? DEFAULT_STARTING_CAPITAL_USD;
}

function formatStartingCapital(n: number): string {
  return formatMaxBudget(n) ?? `$${Math.round(n)}`;
}

function pnlPctOfCapital(pnlUsd: number, capitalUsd: number): number {
  if (!(capitalUsd > 0)) return 0;
  return (pnlUsd / capitalUsd) * 100;
}

/** Shift API `$1000 + PnL` series onto this agent's starting capital. */
function equityForStartingCapital(
  points: ShowcaseAgent['equity'],
  capitalUsd: number,
): ShowcaseAgent['equity'] {
  const shift = capitalUsd - API_EQUITY_BASELINE_USD;
  if (shift === 0) return points;
  return points.map((p) => ({ ...p, indexed: p.indexed + shift }));
}

type BookTab = 'positions' | 'orders' | 'closed';

const CLOSED_PAGE_SIZE = 10;

function displaySym(s: string) {
  return s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
}

function formatUsd(n: number, digits = 0) {
  const factor = 10 ** digits;
  const rounded = Math.round(n * factor) / factor;
  // Sign from rounded value so −$0.01 never becomes "−$0".
  if (Object.is(rounded, -0) || rounded === 0) {
    return `$${Math.abs(rounded).toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    })}`;
  }
  const sign = rounded > 0 ? '+' : '−';
  return `${sign}$${Math.abs(rounded).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`;
}

/** Chip / hero PnL — show cents for sub-$1 moves so tiny losses aren't "−$0". */
function formatPnlUsd(n: number) {
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? 2 : abs < 100 ? 1 : 0;
  return formatUsd(n, digits);
}

function formatPct(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

function formatDecisionPnlPct(n: number) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
}

function formatSignedUsd(n: number, digits = 2) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}`;
}

function useNextCycleCountdown() {
  const [label, setLabel] = useState(() =>
    formatCycleCountdown(msUntilNextHourlyCycle()),
  );
  useEffect(() => {
    const tick = () => setLabel(formatCycleCountdown(msUntilNextHourlyCycle()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  return label;
}

function pnlClass(n: number) {
  // Match dollar rounding used in formatPnlUsd (≥$1 → 1dp, else 2dp / 0dp).
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? 2 : abs < 100 ? 1 : 0;
  const factor = 10 ** digits;
  const rounded = Math.round(n * factor) / factor;
  if (rounded > 0) return 'up';
  if (rounded < 0) return 'down';
  return 'flat';
}

function horizonLabel(h: string) {
  return h === 'investor' ? 'Investor' : h === 'swing' ? 'Swing' : 'Scalper';
}

/**
 * Direction / mandate for agent cards (chip-budget teal).
 * CSS uppercases → "FREE FORM" / "LONG | ACTIVE" / "SHORT | ACCUMULATE".
 */
function mandateBadgeLabel(agent: { direction?: string; mandate?: string }) {
  const d = agent.direction || 'long_short';
  if (d !== 'long_only' && d !== 'short_only') return 'Free form';
  const side = d === 'long_only' ? 'Long' : 'Short';
  const mode = agent.mandate === 'accumulate' ? 'Accumulate' : 'Active';
  return `${side} | ${mode}`;
}

function mandateBadgeHint(agent: { direction?: string; mandate?: string }) {
  const d = agent.direction || 'long_short';
  const m = agent.mandate || 'active';
  if (d === 'long_only' && m === 'accumulate') {
    return 'Long · Accumulate: only the long side; builds exposure on weakness (no auto take-profit). Success = better average entry.';
  }
  if (d === 'short_only' && m === 'accumulate') {
    return 'Short · Accumulate: only the short side; adds on strength (no auto take-profit). Success = better average short entry.';
  }
  if (d === 'long_only') {
    return 'Long · Active: one-sided — only longs; a bearish read means staying flat. Stop + take-profit, manage for realized P&L.';
  }
  if (d === 'short_only') {
    return 'Short · Active: one-sided — only shorts; a bullish read means staying flat. Stop + take-profit, manage for realized P&L.';
  }
  return 'Free form: the AI chooses long, short, or flat from its own read (default).';
}

function horizonHint(h: string) {
  if (h === 'investor') {
    return 'Investor: weeks+ holds. Looks for entries every hour (to catch options/macro shifts), but re-manages open positions about every ~4 hours unless risk fires — wider stops, larger targets, longer-term EMAs/macro. Best with low leverage (≤3x).';
  }
  if (h === 'swing') {
    return 'Swing: days-scale trend trading. Looks for entries every hour, uses wider stops and larger targets, holds through intraday noise. Works best with lower leverage.';
  }
  return 'Scalper: hours-scale trading. Looks for entries every hour, uses tighter stops and quicker profit-taking, reacts fast to order flow.';
}

/** Compact shared notional ceiling — $1k / $10k / $2.5k. */
function formatMaxBudget(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000) {
    const k = n / 1000;
    const label = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `$${label}k`;
  }
  return `$${Math.round(n)}`;
}

function agentStatusKey(status: string | null | undefined) {
  return String(status || '').toLowerCase();
}

/** Non-active house agents still appear — surface Stopped / Paused clearly. */
function statusLabel(status: string | null | undefined) {
  const s = agentStatusKey(status);
  if (s === 'stopped') return 'Stopped';
  if (s === 'paused') return 'Paused';
  if (s === 'revoked') return 'Revoked';
  if (s === 'draft') return 'Draft';
  return null;
}

function isAgentInactive(a: Pick<ShowcaseAgent, 'status' | 'live'>) {
  const s = agentStatusKey(a.status);
  if (s === 'stopped' || s === 'paused' || s === 'revoked' || s === 'draft') return true;
  if (a.live === false && s && s !== 'active') return true;
  return a.live === false && !s;
}

function asTs(v: string | number): number {
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : Date.now();
}

function timeAgo(ts: string | number) {
  const m = Math.max(1, Math.round((Date.now() - asTs(ts)) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function orderKindLabel(kind: string, tpsl?: 'tp' | 'sl' | null) {
  if (tpsl === 'tp' || kind === 'take_profit') return 'Take profit';
  if (tpsl === 'sl' || kind === 'stop') return 'Stop loss';
  return 'Limit';
}

/** Enough fraction digits that cheap perps don't round 0.133 and 0.139 both to 0.13. */
const PRICE_MAX_DIGITS = 8;

function priceFractionDigits(n: number): number {
  const abs = Math.abs(n);
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  if (abs >= 0.1) return 5;
  if (abs >= 0.01) return 6;
  if (abs >= 0.001) return 7;
  return PRICE_MAX_DIGITS;
}

function formatPriceAt(n: number, digits: number): string {
  return n.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function formatPrice(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  return formatPriceAt(n, priceFractionDigits(n));
}

/** Shared digit budget for entry/mark so they stay comparable and don't collide. */
function formatPricePair(
  a: number | null | undefined,
  b: number | null | undefined,
): [string, string] {
  const aOk = a != null && Number.isFinite(a);
  const bOk = b != null && Number.isFinite(b);
  if (!aOk && !bOk) return ['—', '—'];
  if (!aOk) return ['—', formatPrice(b)];
  if (!bOk) return [formatPrice(a), '—'];
  let digits = Math.max(priceFractionDigits(a), priceFractionDigits(b));
  while (digits < PRICE_MAX_DIGITS) {
    const sa = formatPriceAt(a, digits);
    const sb = formatPriceAt(b, digits);
    if (sa !== sb || a === b) return [sa, sb];
    digits += 1;
  }
  return [formatPriceAt(a, digits), formatPriceAt(b, digits)];
}

function formatSize(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function orderBuySell(o: { orderSide?: 'buy' | 'sell'; side: Side }): 'buy' | 'sell' {
  if (o.orderSide === 'buy' || o.orderSide === 'sell') return o.orderSide;
  // Closing a LONG uses sell; closing a SHORT uses buy.
  return o.side === 'LONG' ? 'sell' : 'buy';
}

type ModelProvider = 'openai' | 'gemini' | 'claude' | 'deepseek' | 'xai' | 'unknown';

const PROVIDER_META: Record<
  ModelProvider,
  { label: string; icon: string | null }
> = {
  openai: { label: 'OpenAI', icon: '/providers/chatgpt.webp' },
  gemini: { label: 'Gemini', icon: '/providers/gemini.webp' },
  claude: { label: 'Claude', icon: '/providers/claude.webp' },
  deepseek: { label: 'DeepSeek', icon: '/providers/deepseek.webp' },
  xai: { label: 'xAI', icon: '/providers/xai.webp' },
  unknown: { label: 'Model', icon: null },
};

function resolveModelProvider(model: string): ModelProvider {
  const m = model.toLowerCase();
  if (
    m.includes('gpt') ||
    m.includes('openai') ||
    /\bo[1-4]\b/.test(m) ||
    m.includes('chatgpt')
  ) {
    return 'openai';
  }
  if (m.includes('gemini') || m.includes('google')) return 'gemini';
  if (m.includes('claude') || m.includes('anthropic')) return 'claude';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('grok') || m.includes('xai')) return 'xai';
  return 'unknown';
}

/** Legacy catalog ids → current house wire names (mirror app / worker). */
function displayModelId(model: string): string {
  const key = model.trim();
  if (!key || key === '—') return key;
  const aliases: Record<string, string> = {
    'gpt-5.6-terra': 'gpt-5.6-terra',
    'gpt-5.6-Terra': 'gpt-5.6-terra',
    'gpt-5.4': 'gpt-5.6-terra',
    'gpt-5.4-mini': 'gpt-5.6-terra',
    'deepseek-v4-flash': 'deepseek-v4-flash',
    'DeepSeek-V4-Flash': 'deepseek-v4-flash',
    'DeepSeek-V4-Flash-0731': 'deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek-v4-flash',
    'DeepSeek-V4-Pro': 'deepseek-v4-flash',
    'grok-4.5': 'grok-4.5',
    'grok-4.3': 'grok-4.5',
    'gemini-3.7-flash': 'gemini-3.7-flash',
    'gemini-3.6-flash': 'gemini-3.7-flash',
    'gemini-3.5-flash': 'gemini-3.7-flash',
    'gemini-3.5-flash-preview': 'gemini-3.7-flash',
    'claude-opus-5': 'claude-opus-5',
    'claude-opus-4-8': 'claude-opus-5',
    'claude-opus-4.8': 'claude-opus-5',
  };
  if (aliases[key]) return aliases[key];
  const provider = resolveModelProvider(key);
  if (provider === 'openai') return 'gpt-5.6-terra';
  if (provider === 'deepseek') return 'deepseek-v4-flash';
  if (provider === 'xai') return 'grok-4.5';
  if (provider === 'gemini') return 'gemini-3.7-flash';
  return key;
}

/** Agent cards: icon only. Focus meta: icon + model id. */
function ModelProviderBadge({
  model,
  variant = 'meta',
}: {
  model: string;
  variant?: 'icon' | 'meta';
}) {
  const wire = displayModelId(model);
  const provider = resolveModelProvider(wire || model);
  const meta = PROVIDER_META[provider];
  const label = wire && wire !== '—' ? wire : meta.label;

  if (variant === 'icon') {
    return (
      <span className="model-badge model-badge-icon-only" title={label}>
        {meta.icon ? (
          <img src={meta.icon} alt={meta.label} className="model-badge-icon" />
        ) : (
          <span className="model-badge-fallback">{meta.label.slice(0, 1)}</span>
        )}
      </span>
    );
  }

  return (
    <span className="model-badge model-badge-meta" title={label}>
      {meta.icon ? (
        <img src={meta.icon} alt="" className="model-badge-icon" />
      ) : (
        <span className="model-badge-fallback">{meta.label.slice(0, 1)}</span>
      )}
      <span className="model-badge-text">{label}</span>
    </span>
  );
}

function SymbolBadge({ symbol }: { symbol: string }) {
  const label = displaySym(symbol);
  const src = symbolLogoSrc(symbol);
  return (
    <span className="symbol-badge" title={label}>
      {src ? (
        <img src={src} alt="" className="symbol-badge-icon" />
      ) : (
        <span className="symbol-badge-fallback">{label.slice(0, 1)}</span>
      )}
      <span className="symbol-badge-text">{label}</span>
    </span>
  );
}

export default function App() {
  const [agents, setAgents] = useState<ShowcaseAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookTab, setBookTab] = useState<BookTab>('positions');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDecisionIds, setExpandedDecisionIds] = useState<Record<string, boolean>>(
    {},
  );
  const [stripHasMore, setStripHasMore] = useState(false);
  const [closedShown, setClosedShown] = useState(CLOSED_PAGE_SIZE);
  const stripRef = useRef<HTMLDivElement>(null);
  const nextCycleCountdown = useNextCycleCountdown();

  const updateStripOverflow = () => {
    const el = stripRef.current;
    if (!el) {
      setStripHasMore(false);
      return;
    }
    const remaining = el.scrollWidth - el.scrollLeft - el.clientWidth;
    setStripHasMore(remaining > 8);
  };

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    updateStripOverflow();
    el.addEventListener('scroll', updateStripOverflow, { passive: true });
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (e.deltaY === 0) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(updateStripOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateStripOverflow);
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, [agents.length]);

  useEffect(() => {
    let cancelled = false;
    const ctrl = { current: new AbortController() };

    const load = async () => {
      try {
        const data = await fetchShowcaseAgents(ctrl.current.signal);
        if (cancelled) return;
        setAgents(data.agents || []);
        setError(null);
        setSelectedId((prev) => {
          if (prev && data.agents.some((a) => a.id === prev)) return prev;
          return data.agents[0]?.id ?? null;
        });
      } catch (e: any) {
        if (cancelled || e?.name === 'AbortError') return;
        setError(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const id = window.setInterval(() => {
      ctrl.current.abort();
      ctrl.current = new AbortController();
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      ctrl.current.abort();
      window.clearInterval(id);
    };
  }, []);

  const agent = useMemo(
    () => agents.find((a) => a.id === selectedId) ?? agents[0] ?? null,
    [agents, selectedId],
  );

  useEffect(() => {
    setClosedShown(CLOSED_PAGE_SIZE);
  }, [selectedId]);

  const agentHyperdashUrl = agent ? hyperdashUrlFor(agent.id) : undefined;
  const agentStartingCapital = agent ? startingCapitalUsdFor(agent.id) : DEFAULT_STARTING_CAPITAL_USD;
  const closedVisible = agent ? agent.closed.slice(0, closedShown) : [];
  const closedRemaining = agent ? Math.max(0, agent.closed.length - closedVisible.length) : 0;

  return (
    <div className="app">
      <header className="nav">
        <a className="nav-brand" href="#">
          <img src="/logo.webp" alt="" />
          <span>HyperTrade</span>
        </a>
        <div className="nav-links">
          <a className="hide-sm" href="#agents">
            Agents
          </a>
          <a className="hide-sm" href="#about">
            About
          </a>
          <a className="hide-sm" href="#faq">
            FAQ
          </a>
          <a className="btn btn-primary" href={PLAY} target="_blank" rel="noreferrer">
            <GooglePlayIcon size={15} />
            Get the app
          </a>
        </div>
      </header>

      <section className="hero">
        <div className="hero-kicker-wrap">
          <div className="hero-kicker">
            <span className="live-dot" />
            Live showcase · read only
          </div>
          <p className="hero-phase">Phase 0: Testing</p>
        </div>
        <h1>
          AI agents that trade
          <br />
          <span className="nowrap">with you</span>
        </h1>
        <p>
          House-funded agents on Hyperliquid — symbols, PnL vs each agent's starting capital, and
          the reasoning trail. Launch your own in the HyperTrade app.
        </p>
      </section>

      <div className="strip-label" id="agents">
        Agents
      </div>
      {loading && agents.length === 0 ? (
        <div
          className="agent-strip-wrap agent-loading"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="agent-loading-label">
            <span className="agent-loading-dot" aria-hidden />
            Loading live agents
          </div>
          <div className="agent-strip agent-strip-skeleton">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="agent-chip agent-chip-skeleton"
                style={{ animationDelay: `${i * 0.12}s` }}
                aria-hidden
              >
                <div className="skel-row skel-top">
                  <span className="skel-bar skel-name" />
                  <span className="skel-bar skel-badge" />
                </div>
                <div className="skel-row skel-mid">
                  <span className="skel-dot" />
                  <span className="skel-dot" />
                  <span className="skel-dot" />
                </div>
                <div className="skel-row skel-foot">
                  <span className="skel-bar skel-pnl" />
                  <span className="skel-bar skel-spark" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : error && agents.length === 0 ? (
        <div className="empty">Couldn’t load showcase ({error}).</div>
      ) : agents.length === 0 ? (
        <div className="empty">No showcase agents right now — check back soon.</div>
      ) : (
        <div className={`agent-strip-wrap${stripHasMore ? ' has-more' : ''}`}>
          <div
            className="agent-strip"
            ref={stripRef}
            role="tablist"
            aria-label="Showcase agents"
          >
            {agents.map((a) => {
              const d = a.pnlFrom1k;
              const capital = startingCapitalUsdFor(a.id);
              const active = a.id === agent?.id;
              const inactive = isAgentInactive(a);
              const stoppedLabel = statusLabel(a.status);
              const hyperdashUrl = hyperdashUrlFor(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`agent-chip${active ? ' active' : ''}${inactive ? ' is-stopped' : ''}`}
                  onClick={() => {
                    setSelectedId(a.id);
                    setBookTab('positions');
                    setExpandedDecisionIds({});
                  }}
                >
                  <div className="chip-top">
                    <div className="chip-name">
                      {a.name}
                      {hyperdashUrl ? (
                        <span
                          className="chip-hyperdash"
                          role="link"
                          tabIndex={0}
                          aria-label={`View ${a.name} on Hyperdash`}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(hyperdashUrl, '_blank', 'noopener,noreferrer');
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            e.stopPropagation();
                            window.open(hyperdashUrl, '_blank', 'noopener,noreferrer');
                          }}
                        >
                          <ExternalLinkIcon size={13} />
                        </span>
                      ) : null}
                      {stoppedLabel ? (
                        <span className="chip-status" title={`Agent is ${stoppedLabel.toLowerCase()}`}>
                          {stoppedLabel}
                        </span>
                      ) : null}
                    </div>
                    <div className="chip-badges">
                      <div className="chip-horizon">
                        <span className="chip-horizon-text">
                          {horizonLabel(String(a.horizon || 'scalper'))}
                        </span>
                        <HorizonHint hint={horizonHint(String(a.horizon || 'scalper'))} />
                      </div>
                      <div className="chip-budget" title={mandateBadgeHint(a)}>
                        {mandateBadgeLabel(a)}
                      </div>
                    </div>
                  </div>
                  <div className="chip-model">
                    <ModelProviderBadge model={String(a.model || '')} variant="icon" />
                    {a.symbols.length > 0 ? (
                      <span className="chip-asset-logos" aria-label="Markets">
                        {a.symbols.slice(0, 4).map((s) => {
                          const label = displaySym(s);
                          const src = symbolLogoSrc(s);
                          return (
                            <span key={s} className="chip-asset-logo" title={label}>
                              {src ? (
                                <img src={src} alt={label} />
                              ) : (
                                <span className="chip-asset-fallback">
                                  {label.slice(0, 1)}
                                </span>
                              )}
                            </span>
                          );
                        })}
                        {a.symbols.length > 4 ? (
                          <span className="chip-asset-more">+{a.symbols.length - 4}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <div className="chip-foot">
                    <div>
                      <div className={`chip-pnl ${pnlClass(d)}`}>{formatPnlUsd(d)}</div>
                      <div className="chip-pnl-sub">
                        from {formatStartingCapital(capital)} ·{' '}
                        {formatPct(pnlPctOfCapital(d, capital))}
                      </div>
                    </div>
                    <Sparkline points={a.equity} />
                  </div>
                </button>
              );
            })}
            <span className="agent-strip-end-spacer" aria-hidden />
          </div>
        </div>
      )}

      {agent ? (
        <section className="focus" aria-live="polite">
          <div className="focus-head">
            <div className="focus-title-row">
              <h2>
                {agent.name}
                {agentHyperdashUrl ? (
                  <a
                    className="focus-hyperdash"
                    href={agentHyperdashUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`View ${agent.name} on Hyperdash`}
                  >
                    <ExternalLinkIcon size={16} />
                  </a>
                ) : null}
                {statusLabel(agent.status) ? (
                  <span className="focus-status">{statusLabel(agent.status)}</span>
                ) : null}
              </h2>
              <div className="focus-stats">
                <div className="stat">
                  <span className="stat-label">
                    P&amp;L from {formatStartingCapital(agentStartingCapital)}
                  </span>
                  <div className={`stat-value ${pnlClass(agent.pnlFrom1k)}`}>
                    {formatPnlUsd(agent.pnlFrom1k)}{' '}
                    <span className="stat-pct">
                      ({formatPct(pnlPctOfCapital(agent.pnlFrom1k, agentStartingCapital))})
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="focus-meta">
              {formatMaxBudget(agent.maxCapitalUsd) ? (
                <span
                  className="focus-meta-chip focus-meta-budget"
                  title="Max total notional across assigned markets"
                >
                  Max notional {formatMaxBudget(agent.maxCapitalUsd)}
                </span>
              ) : null}
              <span className="focus-meta-chip focus-meta-model">
                <ModelProviderBadge model={String(agent.model || '')} variant="meta" />
              </span>
              <span className="focus-meta-chip focus-meta-symbols">
                {agent.symbols.map((s) => (
                  <SymbolBadge key={s} symbol={s} />
                ))}
              </span>
            </div>
            {isAgentInactive(agent) ? (
              <p className="focus-stopped-note">
                This agent is {statusLabel(agent.status)?.toLowerCase() || 'inactive'} — no new
                decisions until it is started again. Open positions and history still show below.
              </p>
            ) : null}
          </div>
          <EquityChart
            points={equityForStartingCapital(agent.equity, agentStartingCapital)}
            baselineUsd={agentStartingCapital}
          />

          <div className="focus-grid">
            <div className="panel">
              <div className="book-tabs" role="tablist" aria-label="Book views">
                {(
                  [
                    ['positions', 'Live positions', agent.positions.length],
                    ['orders', 'Orders', agent.openOrders.length],
                    ['closed', 'Completed', agent.closed.length],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={bookTab === id}
                    className={`book-tab${bookTab === id ? ' active' : ''}`}
                    onClick={() => setBookTab(id)}
                  >
                    {label}
                    <span className="book-tab-count">({count})</span>
                  </button>
                ))}
              </div>

              {bookTab === 'positions' &&
                (agent.positions.length === 0 ? (
                  <div className="empty">Flat or manually closed — no open positions.</div>
                ) : (
                  agent.positions.map((p) => {
                    const isLong = p.side === 'LONG';
                    const [entryLabel, markLabel] = formatPricePair(p.entry, p.mark);
                    const pnlTone =
                      p.unrealizedPnl == null && p.unrealizedPct == null
                        ? ''
                        : (p.unrealizedPnl ?? p.unrealizedPct ?? 0) >= 0
                          ? 'tone-positive'
                          : 'tone-negative';
                    return (
                      <div className="book-card" key={p.symbol + p.side}>
                        <div className="book-card-head">
                          <span className="sym-badge">{displaySym(p.symbol)}</span>
                          {p.manual ? (
                            <span
                              className="meta-badge meta-badge-manual"
                              title="Opened on this book outside the agent — not an AI decision"
                            >
                              Manual
                            </span>
                          ) : null}
                          {p.marginType ? (
                            <span className="meta-badge meta-badge-margin">
                              {p.marginType === 'cross' ? 'Cross' : 'Isolated'}
                            </span>
                          ) : null}
                          {p.leverage != null ? (
                            <span className="meta-badge">{Math.round(p.leverage)}x</span>
                          ) : null}
                          <span className={`side-pill ${isLong ? 'long' : 'short'}`}>
                            {p.side}
                          </span>
                        </div>
                        <div className="metrics-grid">
                          <div className="metric">
                            <span className="metric-label">Entry</span>
                            <span className="metric-value">{entryLabel}</span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Mark</span>
                            <span className="metric-value">{markLabel}</span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Size</span>
                            <span className="metric-value">
                              {p.sizeUsd != null
                                ? `$${p.sizeUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Margin</span>
                            <span className="metric-value">
                              {p.marginUsed != null
                                ? `$${p.marginUsed.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Liq</span>
                            <span className="metric-value">
                              {p.liquidationPx != null ? formatPrice(p.liquidationPx) : 'N/A'}
                            </span>
                          </div>
                          <div className="metric">
                            <span
                              className="metric-label"
                              title="Funding received since this position opened"
                            >
                              Funding
                            </span>
                            <span
                              className={`metric-value${
                                p.fundingUsd == null
                                  ? ''
                                  : p.fundingUsd > 0
                                    ? ' tone-positive'
                                    : p.fundingUsd < 0
                                      ? ' tone-negative'
                                      : ''
                              }`}
                            >
                              {p.fundingUsd != null ? formatSignedUsd(p.fundingUsd) : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">PnL</span>
                            <span className={`metric-value ${pnlTone}`}>
                              {p.unrealizedPnl != null
                                ? formatSignedUsd(p.unrealizedPnl)
                                : '—'}
                            </span>
                            {p.unrealizedPct != null ? (
                              <span className={`metric-pct ${pnlTone}`}>
                                {formatDecisionPnlPct(p.unrealizedPct)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })
                ))}

              {bookTab === 'orders' &&
                (agent.openOrders.length === 0 ? (
                  <div className="empty">No open orders.</div>
                ) : (
                  agent.openOrders.map((o, i) => {
                    const buySell = orderBuySell(o);
                    const isTpSl = o.kind === 'stop' || o.kind === 'take_profit';
                    const pos = agent.positions.find((p) => p.symbol === o.symbol);
                    const sizeLabel = formatSize(o.size ?? null);
                    const valueUsd =
                      o.size != null && o.triggerPx != null
                        ? o.size * o.triggerPx
                        : pos?.sizeUsd ?? null;
                    const typeClass =
                      o.tpsl === 'sl' || o.kind === 'stop'
                        ? 'sl'
                        : o.tpsl === 'tp' || o.kind === 'take_profit'
                          ? 'tp'
                          : 'limit';
                    return (
                      <div className="book-card" key={`${o.symbol}-${o.kind}-${i}`}>
                        <div className="book-card-head">
                          <span className="sym-badge">{displaySym(o.symbol)}</span>
                          <span className={`type-chip ${typeClass}`}>
                            {orderKindLabel(o.kind, o.tpsl)}
                          </span>
                          <span className={`side-pill ${buySell === 'buy' ? 'long' : 'short'}`}>
                            {buySell === 'buy' ? 'Buy' : 'Sell'}
                          </span>
                        </div>
                        <div className="metrics-grid">
                          <div className="metric">
                            <span className="metric-label">
                              {isTpSl ? 'Trigger' : 'Price'}
                            </span>
                            <span className="metric-value">
                              {o.triggerPx != null ? formatPrice(o.triggerPx) : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Size</span>
                            <span className="metric-value">
                              {sizeLabel ?? (isTpSl ? 'Full close' : '—')}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Value</span>
                            <span className="metric-value">
                              {valueUsd != null
                                ? `$${valueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Type</span>
                            <span className="metric-value metric-value-muted">
                              {o.reduceOnly || isTpSl ? 'Reduce-only' : 'Working'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ))}

              {bookTab === 'closed' &&
                (agent.closed.length === 0 ? (
                  <div className="empty">No fills on this book yet.</div>
                ) : (
                  <>
                    {closedVisible.map((t, i) => {
                    const buySell =
                      t.orderSide === 'buy' || t.orderSide === 'sell'
                        ? t.orderSide
                        : t.side === 'LONG'
                          ? 'buy'
                          : 'sell';
                    const isBuy = buySell === 'buy';
                    const pnlTone =
                      t.pnlUsd == null
                        ? ''
                        : t.pnlUsd > 0
                          ? 'tone-positive'
                          : t.pnlUsd < 0
                            ? 'tone-negative'
                            : '';
                    return (
                      <div className="book-card" key={`${t.symbol}-${t.closedAt}-${i}`}>
                        <div className="book-card-head">
                          <span className="sym-badge">{displaySym(t.symbol)}</span>
                          {t.ai ? (
                            <span
                              className="meta-badge meta-badge-ai"
                              title="Filled by this agent"
                            >
                              AI
                            </span>
                          ) : (
                            <span
                              className="meta-badge meta-badge-manual"
                              title="Filled on this book outside the agent"
                            >
                              Manual
                            </span>
                          )}
                          <span className={`side-pill ${isBuy ? 'long' : 'short'}`}>
                            {isBuy ? 'Buy' : 'Sell'}
                          </span>
                          {t.dir ? (
                            <span className="meta-badge" title={t.dir}>
                              {t.dir}
                            </span>
                          ) : null}
                          {t.closedAt ? (
                            <span className="book-card-time">{timeAgo(t.closedAt)}</span>
                          ) : null}
                        </div>
                        <div className="metrics-grid">
                          <div className="metric">
                            <span className="metric-label">
                              {t.priceIsEntry ? 'Entry' : 'Price'}
                            </span>
                            <span className="metric-value">
                              {t.closePrice != null ? formatPrice(t.closePrice) : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Value</span>
                            <span className="metric-value">
                              {t.valueUsd != null
                                ? `$${t.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                                : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">PnL</span>
                            <span className={`metric-value ${pnlTone}`}>
                              {t.pnlUsd != null ? formatSignedUsd(t.pnlUsd) : '—'}
                            </span>
                          </div>
                          <div className="metric">
                            <span className="metric-label">Fee</span>
                            <span className="metric-value metric-value-muted">
                              {t.feeUsd != null
                                ? `$${Math.abs(t.feeUsd).toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                    minimumFractionDigits: 2,
                                  })}`
                                : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                    })}
                    {closedRemaining > 0 ? (
                      <button
                        type="button"
                        className="book-show-more"
                        onClick={() =>
                          setClosedShown((n) => n + CLOSED_PAGE_SIZE)
                        }
                      >
                        Show more ({closedRemaining})
                      </button>
                    ) : null}
                  </>
                ))}
            </div>

            <div className="panel">
              <div className={`opening-box${agent.opening ? '' : ' opening-box-empty'}`}>
                <h3>Opening</h3>
                {agent.opening ? (
                  <>
                    <div
                      className={`opening-side ${
                        agent.opening.side === 'LONG' ? 'tone-positive' : 'tone-negative'
                      }`}
                    >
                      Opened {agent.opening.side} · {displaySym(agent.opening.symbol)}
                    </div>
                    <div className="opening-conviction">
                      Conviction:{' '}
                      <strong>
                        {agent.opening.conviction != null
                          ? `${agent.opening.conviction}/100`
                          : '—'}
                      </strong>
                      <span style={{ color: 'var(--text-3)' }}>
                        {' '}
                        · {timeAgo(agent.opening.at)}
                      </span>
                    </div>
                    {agent.opening.summary ? (
                      <div className="opening-summary">{agent.opening.summary}</div>
                    ) : null}
                    {agent.opening.reasoning ? (
                      <div className="opening-reason">{agent.opening.reasoning}</div>
                    ) : null}
                    <div className="opening-meta">
                      {agent.opening.entryPrice != null ? (
                        <span>Entry {formatPrice(agent.opening.entryPrice)}</span>
                      ) : null}
                      {agent.opening.stopPrice != null ? (
                        <span>SL {formatPrice(agent.opening.stopPrice)}</span>
                      ) : null}
                      {agent.opening.takeProfit != null ? (
                        <span>TP {formatPrice(agent.opening.takeProfit)}</span>
                      ) : null}
                    </div>
                  </>
                ) : agent.positions.some((p) => p.manual) ? (
                  <div className="opening-empty">
                    Live position on this book is manual — not opened by the agent. Recent
                    decisions may stay flat until that position is closed.
                  </div>
                ) : (
                  <div className="opening-empty">
                    No position open at the moment — opening thesis appears when this agent is in a
                    live trade.
                  </div>
                )}
              </div>

              <div className="decisions-head">
                <h3>Recent decisions</h3>
                {isAgentInactive(agent) ? (
                  <div className="next-decision is-stopped" title="Agent is not running">
                    <ClockIcon className="icon-clock" size={12} />
                    No new decisions while {statusLabel(agent.status)?.toLowerCase() || 'stopped'}
                  </div>
                ) : (
                  <div className="next-decision" title="Worker runs on the hour">
                    <ClockIcon className="icon-clock" size={12} />
                    Next decision in{' '}
                    <span className="next-decision-time">{nextCycleCountdown}</span>
                  </div>
                )}
              </div>
              {agent.decisions.length === 0 ? (
                <div className="empty">No decisions yet.</div>
              ) : (
                agent.decisions.map((d) => {
                  const expanded = !!expandedDecisionIds[d.id];
                  const hasFullReasoning = !!(d.reasoning && d.reasoning.trim());
                  const dir = d.direction;
                  const pnlTone =
                    d.pnlPct == null
                      ? ''
                      : d.pnlPct > 0
                        ? 'tone-positive'
                        : d.pnlPct < 0
                          ? 'tone-negative'
                          : '';
                  return (
                    <div className="row" key={d.id}>
                      <div className="row-main">
                        <div className="decision-title-row">
                          <div className="row-title decision-title">
                            {displaySym(d.symbol)}
                            {dir ? (
                              <>
                                {' · '}
                                <span
                                  className={
                                    dir === 'LONG' ? 'tone-positive' : 'tone-negative'
                                  }
                                >
                                  {dir}
                                </span>
                              </>
                            ) : null}
                            {' · '}
                            <span className="decision-action">{d.headline}</span>
                          </div>
                          {d.pnlPct != null ? (
                            <div className={`decision-pnl-float ${pnlTone}`}>
                              <span className="decision-pnl-label">PnL at check</span>
                              <span className="decision-pnl-value">
                                {formatDecisionPnlPct(d.pnlPct)}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        {d.conviction != null ? (
                          <div className="decision-meta-line">
                            Conviction: <strong>{d.conviction}/100</strong>
                          </div>
                        ) : null}
                        <div className="row-sub">
                          {d.type.replace(/_/g, ' ')} · {timeAgo(d.at)}
                        </div>
                        {d.body ? <div className="decision-body">{d.body}</div> : null}
                        {hasFullReasoning ? (
                          <>
                            <button
                              type="button"
                              className={`decision-expand${expanded ? ' open' : ''}`}
                              aria-expanded={expanded}
                              onClick={() =>
                                setExpandedDecisionIds((prev) => ({
                                  ...prev,
                                  [d.id]: !prev[d.id],
                                }))
                              }
                            >
                              {expanded ? 'Hide reasoning' : 'Full reasoning'}
                            </button>
                            {expanded ? (
                              <div className="decision-reasoning">{d.reasoning}</div>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      ) : null}

      <section className="cta-band">
        <div>
          <h2>Launch your own agents</h2>
          <p>
            This page is a showcase — create and supervise agents inside HyperTrade with your budget
            and risk limits.
          </p>
        </div>
        <a className="btn btn-primary" href={PLAY} target="_blank" rel="noreferrer">
          <GooglePlayIcon size={16} />
          Install on Google Play
        </a>
      </section>

      <section className="about" id="about">
        <h2>About</h2>
        <div className="about-grid">
          <div className="about-copy">
            <p>
              <strong style={{ color: 'var(--text)' }}>HyperTrade</strong> is a self-custody
              trading app for stocks, crypto, commodities, and forex perps on Hyperliquid — with
              AI agents that sit on your book as copilots, not black boxes.
            </p>
            <p>
              This page is a live, read-only window into house-funded agents: indexed equity from
              each agent's starting capital, open positions and orders, completed trades, and the
              decision trail behind each move. Nothing here is financial advice — it is a product
              showcase.
            </p>
            <ul className="about-points">
              <li>You keep the keys — agents trade under limits you set in the app</li>
              <li>Reasoning, conviction, and risk levels are visible after every cycle</li>
              <li>Built for Hyperliquid perps across stocks and crypto</li>
            </ul>
          </div>
          <div className="about-links">
            <a className="about-link" href={MEDIUM} target="_blank" rel="noreferrer">
              <span className="about-link-icon" aria-hidden>
                <MediumIcon size={18} />
              </span>
              <span className="about-link-copy">
                <strong>Building AI That Trades With You</strong>
                <span>Medium</span>
              </span>
            </a>
            <a className="about-link" href={GITHUB_AI_AGENT} target="_blank" rel="noreferrer">
              <span className="about-link-icon" aria-hidden>
                <GitHubIcon size={18} />
              </span>
              <span className="about-link-copy">
                <strong>AI agent worker (open source)</strong>
                <span>GitHub</span>
              </span>
            </a>
            <a className="about-link" href={PLAY} target="_blank" rel="noreferrer">
              <span className="about-link-icon" aria-hidden>
                <GooglePlayIcon size={18} />
              </span>
              <span className="about-link-copy">
                <strong>HyperTrade on Google Play</strong>
                <span>com.hypertrade.app</span>
              </span>
            </a>
            <a className="about-link" href={CONTACT}>
              <span className="about-link-icon" aria-hidden>
                <MailIcon size={18} />
              </span>
              <span className="about-link-copy">
                <strong>Contact us</strong>
                <span>support@hypertrade.exchange</span>
              </span>
            </a>
          </div>
          <div className="about-faq" id="faq">
            <div className="about-faq-head">
              <h3>AI Agents FAQ</h3>
              <p>
                Same questions we answer in the app — how agents decide, risk limits, cooldowns, and
                what you control.
              </p>
            </div>
            <FaqAccordion items={SHOWCASE_FAQ} />
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>© {new Date().getFullYear()} Lunatic Wisdom Labs LLC · HyperTrade</span>
        <span>Showcase only · not financial advice</span>
      </footer>
    </div>
  );
}
