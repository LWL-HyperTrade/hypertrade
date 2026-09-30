/**
 * Desk chip for the tenant's resident (docs/RESIDENTS.md §5).
 *
 * Same overlay chrome as StreamDock: header chip when docked, drag to undock,
 * lock to pin back. Collapsed chip sits next to Twitch; expanded card is VRM + book.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchTenantResident } from '../../lib/api';
import {
  RESIDENT_MOOD_LABEL,
  avatarModelUrl,
  avatarPosterUrl,
  avatarFallbackAnim,
  avatarIdleAnims,
  displayResidentMood,
  formatCycleCountdown,
  msUntilNextHourlyCycle,
  residentAgentPnl,
  residentPublicName,
  type ResidentAvatar,
  type ResidentMood,
} from '../../lib/residents';
import type { TenantPublic } from '../../lib/tenants';
import { IconClose, IconLock, IconOverlay, IconUnlock } from '../icons';

const VrmStage = lazy(() => import('./VrmStage').then((m) => ({ default: m.VrmStage })));

const CARD_W = 280;
const CARD_H = 360;
const CHIP_W = 168;
const CHIP_H = 26;
const FAB = 44;
const PAD = 12;
const DRAG_PX = 6;
const NARROW_MQ = '(max-width: 639px)';
export const RESIDENT_DOCK_EVENT = 'bp-resident-dock';

type Layout = { x: number; y: number };

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  orig: Layout;
  moved: boolean;
};

function storageKey(slug: string) {
  return `bp-resident-dock:${slug}`;
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(NARROW_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function boxSize(expanded: boolean, fab: boolean) {
  if (expanded) return { w: CARD_W, h: CARD_H };
  return fab ? { w: FAB, h: FAB } : { w: CHIP_W, h: CHIP_H };
}

function clamp(layout: Layout, expanded: boolean, fab: boolean): Layout {
  if (typeof window === 'undefined') return layout;
  const { w, h } = boxSize(expanded, fab);
  return {
    x: Math.min(Math.max(PAD, window.innerWidth - w - PAD), Math.max(PAD, layout.x)),
    y: Math.min(Math.max(PAD, window.innerHeight - h - PAD), Math.max(PAD, layout.y)),
  };
}

function slotOrigin(slot: HTMLElement | null, expanded: boolean): Layout | null {
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: expanded ? r.bottom + 8 : r.top };
}

function defaultLayout(): Layout {
  return { x: PAD, y: PAD };
}

function defaultFabOrigin(): Layout {
  if (typeof window === 'undefined') return { x: PAD, y: 180 };
  return { x: PAD, y: Math.max(88, Math.round(window.innerHeight * 0.42)) };
}

function readSaved(slug: string) {
  try {
    const raw = localStorage.getItem(storageKey(slug));
    if (raw) {
      const parsed = JSON.parse(raw) as {
        x?: number;
        y?: number;
        docked?: boolean;
        dismissed?: boolean;
      };
      return {
        layout: {
          x: typeof parsed.x === 'number' ? parsed.x : PAD,
          y: typeof parsed.y === 'number' ? parsed.y : PAD,
        },
        docked: parsed.docked !== false,
        dismissed: parsed.dismissed === true,
      };
    }
  } catch {
    /* private mode */
  }
  return { layout: defaultLayout(), docked: true, dismissed: false };
}

function persistState(slug: string, layout: Layout, docked: boolean, dismissed: boolean) {
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify({ ...layout, docked, dismissed }));
  } catch {
    /* ignore */
  }
}

export function isResidentDockDismissed(slug: string): boolean {
  return readSaved(slug).dismissed;
}

export function showResidentDock(slug: string) {
  const cur = readSaved(slug);
  persistState(slug, cur.layout, cur.docked, false);
  window.dispatchEvent(new CustomEvent(RESIDENT_DOCK_EVENT, { detail: { slug } }));
}

export function ResidentDockRestoreButton({
  slug,
  onShown,
}: {
  slug: string;
  onShown?: () => void;
}) {
  const [hidden, setHidden] = useState(() =>
    typeof window === 'undefined' ? false : isResidentDockDismissed(slug),
  );
  useEffect(() => {
    const sync = (e?: Event) => {
      const from = (e as CustomEvent<{ slug?: string }> | undefined)?.detail?.slug;
      if (from && from !== slug) return;
      setHidden(isResidentDockDismissed(slug));
    };
    window.addEventListener(RESIDENT_DOCK_EVENT, sync);
    return () => window.removeEventListener(RESIDENT_DOCK_EVENT, sync);
  }, [slug]);
  if (!hidden) return null;
  return (
    <button
      type="button"
      className="mt-2 flex w-full items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px] font-bold text-fg hover:bg-fill-weak"
      onClick={() => {
        showResidentDock(slug);
        onShown?.();
      }}
    >
      <IconOverlay size={15} className="opacity-80" />
      Show resident
    </button>
  );
}

function agentPnl(a: Parameters<typeof residentAgentPnl>[0]): number {
  return residentAgentPnl(a);
}

function fmtUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 ? 1 : 0 })}`;
}

function useCountdown(): string {
  const [label, setLabel] = useState(() => formatCycleCountdown(msUntilNextHourlyCycle()));
  useEffect(() => {
    const id = window.setInterval(() => setLabel(formatCycleCountdown(msUntilNextHourlyCycle())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return label;
}

export function ResidentDock({
  tenant,
  slotRef,
}: {
  tenant: TenantPublic;
  slotRef: RefObject<HTMLElement | null>;
}) {
  const summary = tenant.resident;
  const saved = typeof window === 'undefined' ? { layout: defaultLayout(), docked: true, dismissed: false } : readSaved(tenant.slug);
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const [docked, setDocked] = useState(saved.docked);
  const [dismissed, setDismissed] = useState(saved.dismissed);
  const dismissedRef = useRef(saved.dismissed);
  const [layout, setLayout] = useState<Layout>(saved.layout);
  const gesture = useRef<Gesture | null>(null);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const countdown = useCountdown();
  const fab = narrow && !expanded;

  useLayoutEffect(() => {
    setSlotEl(slotRef.current);
  }, [slotRef]);

  const persist = useCallback(
    (next: Layout, nextDocked: boolean, nextDismissed?: boolean) => {
      const dismissedVal = nextDismissed ?? dismissedRef.current;
      persistState(tenant.slug, next, nextDocked, dismissedVal);
    },
    [tenant.slug],
  );

  useEffect(() => {
    const on = (e: Event) => {
      const from = (e as CustomEvent<{ slug?: string }>).detail?.slug;
      if (from && from !== tenant.slug) return;
      const next = isResidentDockDismissed(tenant.slug);
      dismissedRef.current = next;
      setDismissed(next);
    };
    window.addEventListener(RESIDENT_DOCK_EVENT, on);
    return () => window.removeEventListener(RESIDENT_DOCK_EVENT, on);
  }, [tenant.slug]);

  useEffect(() => {
    const fit = () => {
      if (narrow && !expanded) {
        setLayout((l) => {
          const origin = docked ? defaultFabOrigin() : l;
          return clamp({ ...l, ...origin }, false, true);
        });
        return;
      }
      if (docked) {
        const origin = slotOrigin(slotEl, expanded);
        if (origin && expanded) {
          setLayout((l) => clamp({ ...l, ...origin }, true, false));
          return;
        }
      }
      setLayout((l) => clamp(l, expanded, fab));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [expanded, docked, slotEl, narrow, fab]);

  const q = useQuery({
    queryKey: ['tenant-resident', tenant.slug],
    queryFn: () => fetchTenantResident(tenant.slug),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    enabled: !!summary,
  });

  const persona = q.data?.persona ?? summary?.persona ?? {};
  const avatar = (q.data?.avatar ?? summary?.avatar ?? {}) as ResidentAvatar | Record<string, never>;
  const avatarTyped = 'kind' in avatar ? (avatar as ResidentAvatar) : null;
  const mood: ResidentMood = displayResidentMood(q.data?.mood, q.data?.agents);
  const name = residentPublicName(q.data?.agents, persona, tenant.app_name);
  const poster = avatarPosterUrl(avatarTyped);
  const totalPnl = useMemo(
    () => (q.data?.agents ?? []).reduce((s, a) => s + agentPnl(a), 0),
    [q.data?.agents],
  );
  const livePip = mood === 'sleep' ? 'bg-fg-subtle' : 'bg-success pulse-dot';

  const endGesture = (el: HTMLElement, pointerId: number) => {
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  const onMoveDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      orig: layout,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && dx * dx + dy * dy < DRAG_PX * DRAG_PX) return;
    g.moved = true;
    if (docked) setDocked(false);
    setLayout(clamp({ ...g.orig, x: g.orig.x + dx, y: g.orig.y + dy }, expanded, fab));
  };

  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    endGesture(e.currentTarget as HTMLElement, e.pointerId);
    if (g.moved) {
      setLayout((l) => {
        const next = clamp(l, expanded, fab);
        persist(next, false);
        return next;
      });
      setDocked(false);
      return;
    }
    if (!expanded) {
      if (narrow) {
        setLayout((l) => clamp({ ...l, x: PAD, y: Math.max(PAD, Math.min(l.y, 72)) }, true, false));
      } else {
        const origin = docked ? slotOrigin(slotEl, true) : null;
        if (origin) setLayout((l) => clamp({ ...l, ...origin }, true, false));
      }
      setExpanded(true);
    }
  };

  const toggleDock = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (docked) {
      const origin = slotOrigin(slotEl, false);
      const next = clamp({ ...layout, ...(origin ?? {}) }, expanded, fab);
      setDocked(false);
      setLayout(next);
      persist(next, false);
      return;
    }
    setDocked(true);
    persist(layout, true);
    if (expanded) setExpanded(false);
  };

  const hide = useCallback(() => {
    dismissedRef.current = true;
    setDismissed(true);
    setExpanded(false);
    persist(layout, docked, true);
    window.dispatchEvent(new CustomEvent(RESIDENT_DOCK_EVENT, { detail: { slug: tenant.slug } }));
  }, [tenant.slug, layout, docked, persist]);

  const openFromDock = () => {
    const origin = slotOrigin(slotEl, true);
    if (origin) setLayout((l) => clamp({ ...l, ...origin }, true, false));
    setExpanded(true);
  };

  if (!summary) return null;

  const headerChip = !narrow && docked && !expanded;
  const floating = !headerChip;

  const lockBtn = narrow ? null : (
    <button
      type="button"
      title={docked ? 'Undock to drag' : 'Dock next to markets'}
      aria-label={docked ? 'Undock resident' : 'Dock resident'}
      className="inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-fg-muted hover:text-fg"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggleDock}
    >
      {docked ? <IconUnlock size={12} /> : <IconLock size={12} />}
    </button>
  );

  const chip = (
    <div
      role="button"
      tabIndex={0}
      data-overlay-chip=""
      className={`relative inline-flex touch-none items-center overflow-hidden border border-stroke-weak bg-background text-fg shadow-lg ${
        fab
          ? 'size-11 cursor-grab justify-center rounded-full active:cursor-grabbing'
          : `h-[26px] max-w-[12.5rem] gap-1.5 rounded-full py-[0.4rem] pl-1 pr-[0.55rem] text-[12px] font-extrabold leading-none ${
              headerChip ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
            }`
      }`}
      aria-label={`${name} overlay. ${headerChip ? 'Tap to open beside the stream.' : 'Drag to move, tap to open.'}`}
      title="AI resident overlay"
      onPointerDown={headerChip ? undefined : onMoveDown}
      onPointerMove={headerChip ? undefined : onPointerMove}
      onPointerUp={headerChip ? undefined : onPointerUp}
      onPointerCancel={headerChip ? undefined : onPointerUp}
      onClick={headerChip ? openFromDock : undefined}
      onKeyDown={
        headerChip
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFromDock();
              }
            }
          : undefined
      }
    >
      {poster ? (
        <span className={`relative shrink-0 ${fab ? 'h-full w-full' : ''}`}>
          <img
            src={poster}
            alt=""
            className={`object-cover object-top ${fab ? 'h-full w-full' : 'h-5 w-5 rounded-full'}`}
            draggable={false}
          />
          <span
            className={`absolute rounded-full ${livePip} ${
              fab ? 'right-1.5 top-1.5 h-2 w-2 ring-2 ring-background' : '-right-0.5 -top-0.5 h-1.5 w-1.5 ring-2 ring-background'
            }`}
          />
        </span>
      ) : (
        <span className={`relative inline-flex shrink-0 items-center justify-center text-brand ${fab ? 'h-full w-full' : 'pl-0.5'}`}>
          <IconOverlay size={fab ? 18 : 13} />
          <span
            className={`absolute rounded-full ${livePip} ${
              fab ? 'right-1.5 top-1.5 h-2 w-2' : '-right-0.5 -top-0.5 h-1.5 w-1.5'
            }`}
          />
        </span>
      )}
      {fab ? null : (
        <>
          <span className="min-w-0 truncate">{name}</span>
          <IconOverlay size={12} className="shrink-0 text-fg-muted" />
          {lockBtn}
        </>
      )}
    </div>
  );

  const dockedChip = slotEl && headerChip ? createPortal(chip, slotEl) : null;

  return (
    <>
      {dockedChip}
      {floating && !(narrow && dismissed && !expanded) ? (
        <div
          className="fixed z-[44] select-none"
          style={{
            left: layout.x,
            top: layout.y,
            width: expanded ? CARD_W : undefined,
          }}
        >
          {expanded ? (
            <div className="overflow-hidden rounded-xl border border-stroke-weak bg-background shadow-lg">
              <div
                className="flex h-9 cursor-grab touch-none items-center gap-1.5 bg-fill-weak px-2 active:cursor-grabbing"
                onPointerDown={onMoveDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${livePip}`} />
                <IconOverlay size={12} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold">{name}</span>
                <span className="shrink-0 font-mono text-[10px] font-black tabular text-fg-muted">{countdown}</span>
                {lockBtn}
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-fill-hover hover:text-fg"
                  aria-label="Collapse resident"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setExpanded(false)}
                >
                  <IconClose size={12} />
                </button>
              </div>
              <div className="relative h-[240px] bg-[radial-gradient(ellipse_at_bottom,rgba(122,255,190,0.16),transparent_65%)]">
                <Suspense
                  fallback={
                    poster ? (
                      <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain object-bottom" />
                    ) : null
                  }
                >
                  <VrmStage
                    modelUrl={avatarModelUrl(avatarTyped)}
                    posterUrl={poster}
                    fallbackAnim={avatarFallbackAnim(avatarTyped)}
                    idleAnims={avatarIdleAnims(avatarTyped)}
                    mood={mood}
                    className="absolute inset-0"
                  />
                </Suspense>
                <div className="pointer-events-none absolute left-2 top-2 rounded-full border border-line bg-surface/85 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-muted backdrop-blur">
                  {RESIDENT_MOOD_LABEL[mood]}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className={`font-mono text-[13px] font-black tabular ${totalPnl > 0 ? 'text-success' : totalPnl < 0 ? 'text-error' : 'text-fg-muted'}`}>
                  {fmtUsd(totalPnl)}
                </span>
                <span className="text-[10px] font-bold text-fg-subtle">Next decision {countdown}</span>
              </div>
            </div>
          ) : headerChip ? null : (
            <div className="relative">
              {chip}
              {fab ? (
                <button
                  type="button"
                  className={`absolute -top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/25 bg-black/85 text-white shadow ${
                    layout.x > (typeof window === 'undefined' ? 0 : window.innerWidth / 2)
                      ? '-left-1.5'
                      : '-right-1.5'
                  }`}
                  aria-label="Hide resident"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    hide();
                  }}
                >
                  <IconClose size={11} />
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
