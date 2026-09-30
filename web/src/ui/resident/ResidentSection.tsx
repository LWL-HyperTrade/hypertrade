/**
 * Public "The Resident" chapter on the creator landing (docs/RESIDENTS.md §5).
 * VRM stage on the left; mood, newest voice line, next-cycle countdown and the
 * agents' book on the right. Data: GET /api/tenants/{slug}/resident (~28s cache).
 */
import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchTenantResident } from '../../lib/api';
import { formatUsd } from '../../lib/hlMarket';
import { quoteLogoSrc } from '../../lib/quoteLogos';
import chatgptLogo from '../../assets/images/chatgpt.webp';
import claudeLogo from '../../assets/images/claude.webp';
import deepseekLogo from '../../assets/images/deepseek.webp';
import geminiLogo from '../../assets/images/gemini.webp';
import xaiLogo from '../../assets/images/xai.webp';
import {
  RESIDENT_MOOD_LABEL,
  avatarModelUrl,
  avatarPosterUrl,
  avatarFallbackAnim,
  avatarIdleAnims,
  displayResidentMood,
  formatCycleCountdown,
  msUntilNextHourlyCycle,
  formatResidentPnl,
  residentAgentPnl,
  residentPublicName,
  type ResidentAgentSlice,
  type ResidentAvatar,
  type ResidentMood,
  type ResidentVoiceLine,
} from '../../lib/residents';
import type { TenantPublic } from '../../lib/tenants';
import { ResidentDecisions, ResidentWalletLine } from './ResidentDecisions';

/** three.js + VRM only load on pages that actually have a resident. */
const VrmStage = lazy(() => import('./VrmStage').then((m) => ({ default: m.VrmStage })));

const REFRESH_MS = 30_000;
/** How long the newest line keeps the mouth moving after it appears. */
const SPEAK_MS = 6_000;

function useCountdown(): string {
  const [label, setLabel] = useState(() => formatCycleCountdown(msUntilNextHourlyCycle()));
  useEffect(() => {
    const id = window.setInterval(() => setLabel(formatCycleCountdown(msUntilNextHourlyCycle())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return label;
}

function modelLogo(model: string | undefined): string | null {
  const m = (model || '').toLowerCase();
  if (m.includes('gpt') || m.includes('openai')) return chatgptLogo;
  if (m.includes('gemini')) return geminiLogo;
  if (m.includes('grok') || m.includes('xai')) return xaiLogo;
  if (m.includes('deepseek')) return deepseekLogo;
  if (m.includes('claude')) return claudeLogo;
  return null;
}

function marketLabel(symbol: string): string {
  const raw = String(symbol || '');
  return (raw.includes(':') ? raw.split(':').pop() : raw) || raw;
}

function agentPnl(a: ResidentAgentSlice): number {
  return residentAgentPnl(a);
}

export function ResidentSection({ tenant }: { tenant: TenantPublic }) {
  const summary = tenant.resident;
  const q = useQuery({
    queryKey: ['tenant-resident', tenant.slug],
    queryFn: () => fetchTenantResident(tenant.slug),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
    enabled: !!summary,
  });
  const countdown = useCountdown();

  const persona = q.data?.persona ?? summary?.persona ?? {};
  const avatar = (q.data?.avatar ?? summary?.avatar ?? {}) as ResidentAvatar | Record<string, never>;
  const avatarTyped = 'kind' in avatar ? (avatar as ResidentAvatar) : null;
  const mood: ResidentMood = displayResidentMood(q.data?.mood, q.data?.agents);
  const agents = q.data?.agents ?? [];
  const name = residentPublicName(agents, persona, tenant.app_name);
  const voice = q.data?.voice ?? [];
  const latest: ResidentVoiceLine | undefined = voice[0];

  // Mouth flap for a few seconds whenever a newer line lands.
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!latest) return;
    const age = Date.now() - new Date(latest.created_at).getTime();
    if (age > SPEAK_MS) return;
    setSpeaking(true);
    const t = window.setTimeout(() => setSpeaking(false), Math.max(500, SPEAK_MS - age));
    return () => window.clearTimeout(t);
  }, [latest?.id, latest]);

  const totalPnl = useMemo(
    () => formatResidentPnl(agents.reduce((s, a) => s + agentPnl(a), 0)),
    [agents],
  );
  const symbols = useMemo(
    () => [...new Set(agents.flatMap((a) => (a.symbols ?? []).map((s) => String(s).split(':').pop() ?? s)))],
    [agents],
  );
  const openPositions = useMemo(
    () => agents.reduce((n, a) => n + ((a.positions as unknown[] | undefined)?.length ?? 0), 0),
    [agents],
  );

  if (!summary) return null;

  return (
    <section id="resident" className="creator-section mt-6 sm:mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div>
          <span className="eyebrow">AI Resident</span>
          <h2 className="display mt-1 text-2xl sm:text-3xl">{name}</h2>
        </div>
        <p className="max-w-md text-[13px] font-semibold text-fg-muted">
          An AI trader that lives here. Every order it places runs through this app.
        </p>
      </div>

      <div className="grid gap-4 overflow-hidden rounded-2xl border border-line bg-surface md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="relative min-h-[360px] bg-[radial-gradient(ellipse_at_bottom,rgba(122,255,190,0.16),transparent_65%)] sm:min-h-[440px]">
          <Suspense
            fallback={
              avatarPosterUrl(avatarTyped) ? (
                <img src={avatarPosterUrl(avatarTyped) ?? undefined} alt="" className="absolute inset-0 h-full w-full object-contain object-bottom" />
              ) : null
            }
          >
            <VrmStage
              modelUrl={avatarModelUrl(avatarTyped)}
              posterUrl={avatarPosterUrl(avatarTyped)}
              fallbackAnim={avatarFallbackAnim(avatarTyped)}
              idleAnims={avatarIdleAnims(avatarTyped)}
              mood={mood}
              speaking={speaking}
              className="absolute inset-0"
            />
          </Suspense>
          <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 rounded-full border border-line bg-surface/85 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-muted backdrop-blur">
            <span className={`h-1.5 w-1.5 rounded-full ${mood === 'sleep' ? 'bg-fg-subtle' : 'bg-success pulse-dot'}`} />
            {RESIDENT_MOOD_LABEL[mood]}
          </div>
          <div className="pointer-events-none absolute right-4 top-4 rounded-full border border-line bg-surface/85 px-2.5 py-1 font-mono text-[11px] font-black tabular text-fg-muted backdrop-blur">
            NEXT DECISION IN {countdown}
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-start gap-5 p-5 sm:p-7">
          <div>
            {agents.length ? (
              <ul className="grid gap-2">
                {agents.map((a) => {
                  const balance = a.accountValue;
                  const logo = modelLogo(a.model);
                  const syms = (a.symbols ?? []).map((s) => String(s));
                  return (
                    <li key={a.id} className="rounded-2xl border border-line px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            {logo ? <img src={logo} alt="" className="h-4 w-4 shrink-0 object-contain" /> : null}
                            {syms.map((s) => {
                              const label = marketLabel(s);
                              const src = quoteLogoSrc(label);
                              return src ? (
                                <img key={s} src={src} alt="" title={label} className="h-4 w-4 shrink-0 rounded-full object-contain" />
                              ) : (
                                <span key={s} className="text-[11px] font-bold text-fg-subtle">{label}</span>
                              );
                            })}
                            <span className="truncate font-extrabold">{a.name}</span>
                          </div>
                          <div className="mt-1 truncate text-[11px] font-bold text-fg-subtle">
                            {syms.map(marketLabel).join(', ')}
                            {a.horizon ? ` · ${String(a.horizon)}` : ''}
                            {a.model ? ` · ${String(a.model)}` : ''}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2.5">
                          <span className="font-mono text-[20px] font-black tabular leading-none text-fg">
                            {balance != null && Number.isFinite(Number(balance)) ? formatUsd(Number(balance)) : '—'}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em] ${
                              a.status === 'active' ? 'bg-success/15 text-success' : 'bg-fill-weak text-fg-subtle'
                            }`}
                          >
                            {String(a.status)}
                          </span>
                        </div>
                      </div>
                      {a.wallet ? <ResidentWalletLine address={a.wallet} /> : null}
                      {persona.bio_voice?.trim() ? (
                        <p className="mt-2 text-[13px] font-semibold leading-5 text-fg-muted">{persona.bio_voice.trim()}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : q.isLoading ? (
              <div className="h-16 animate-pulse rounded-2xl bg-fill-weak" />
            ) : (
              <div className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] font-semibold text-fg-muted">
                {persona.bio_voice?.trim() || 'No agent on this app yet.'}
              </div>
            )}

            <div className="mt-5 grid grid-cols-3 gap-3">
              <Stat
                label="P&L"
                value={
                  <span className={totalPnl.tone === 'up' ? 'text-success' : totalPnl.tone === 'down' ? 'text-error' : ''}>
                    {totalPnl.text}
                  </span>
                }
              />
              <Stat label="Live Positions" value={String(openPositions)} />
              <Stat label="Markets" value={symbols.length ? symbols.join(' · ') : '—'} />
            </div>
          </div>

          <ResidentDecisions agents={agents} variant="page" />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-fill-weak px-3 py-2">
      <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-black tabular">{value}</div>
    </div>
  );
}
