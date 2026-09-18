import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTenantStream } from '../../lib/api';
import { IconClose, IconLock, IconTwitch, IconUnlock } from '../icons';

const HEADER_H = 36;
const ASPECT = 16 / 9;
const MIN_W = 280;
const DEFAULT_W = 420;
const CHAT_W = 260;
const CHAT_STACK_H = 220;
const CHIP_W = 148;
const CHIP_H = 26;
const FAB = 44;
const PAD = 12;
const DRAG_PX = 6;
const TWITCH = '#9146FF';
const NARROW_MQ = '(max-width: 639px)';

type Corner = 'nw' | 'ne' | 'sw' | 'se';
type Layout = { x: number; y: number; w: number; chat: boolean };

type Gesture =
  | {
      kind: 'move';
      pointerId: number;
      startX: number;
      startY: number;
      orig: Layout;
      moved: boolean;
    }
  | {
      kind: 'resize';
      pointerId: number;
      corner: Corner;
      startX: number;
      startY: number;
      orig: Layout;
    };

function storageKey(slug: string) {
  return `bp-stream-dock:${slug}`;
}

function vidH(w: number) {
  return Math.round(w / ASPECT);
}

function chatBeside(chat: boolean) {
  if (!chat || typeof window === 'undefined') return false;
  return window.innerWidth - PAD * 2 >= MIN_W + CHAT_W;
}

function boxSize(layout: Layout, expanded: boolean, fab = false) {
  if (!expanded) return fab ? { w: FAB, h: FAB } : { w: CHIP_W, h: CHIP_H };
  const videoH = vidH(layout.w);
  if (layout.chat && chatBeside(true)) {
    return { w: layout.w + CHAT_W, h: HEADER_H + videoH };
  }
  if (layout.chat) {
    return { w: layout.w, h: HEADER_H + videoH + CHAT_STACK_H };
  }
  return { w: layout.w, h: HEADER_H + videoH };
}

function defaultFabOrigin(): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: PAD, y: 120 };
  return {
    x: Math.max(PAD, window.innerWidth - FAB - PAD),
    y: Math.max(88, Math.round(window.innerHeight * 0.36)),
  };
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

function maxW(chat: boolean): number {
  if (typeof window === 'undefined') return DEFAULT_W;
  const beside = chatBeside(chat);
  const extraW = beside ? CHAT_W : 0;
  const extraH = chat && !beside ? CHAT_STACK_H : 0;
  const byWidth = window.innerWidth - PAD * 2 - extraW;
  const byHeight = (window.innerHeight - PAD * 2 - HEADER_H - extraH) * ASPECT;
  return Math.max(MIN_W, Math.min(byWidth, byHeight));
}

function clampLayout(layout: Layout, expanded: boolean, fab = false): Layout {
  const w = Math.min(maxW(layout.chat), Math.max(MIN_W, layout.w));
  const next = { ...layout, w };
  const { w: bw, h: bh } = boxSize(next, expanded, fab);
  const maxX = Math.max(PAD, window.innerWidth - bw - PAD);
  const maxY = Math.max(PAD, window.innerHeight - bh - PAD);
  return {
    ...next,
    x: Math.min(maxX, Math.max(PAD, layout.x)),
    y: Math.min(maxY, Math.max(PAD, layout.y)),
  };
}

function slotOrigin(slot: HTMLElement | null, expanded: boolean): { x: number; y: number } | null {
  if (!slot) return null;
  const r = slot.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: expanded ? r.bottom + 8 : r.top };
}

function defaultLayout(): Layout {
  return { x: PAD, y: PAD, w: DEFAULT_W, chat: false };
}

function readSaved(slug: string) {
  try {
    const raw = localStorage.getItem(storageKey(slug));
    if (raw) {
      const parsed = JSON.parse(raw) as {
        x?: number;
        y?: number;
        w?: number;
        chat?: boolean;
        docked?: boolean;
        dismissed?: boolean;
      };
      return {
        layout: {
          x: typeof parsed.x === 'number' ? parsed.x : PAD,
          y: typeof parsed.y === 'number' ? parsed.y : PAD,
          w: typeof parsed.w === 'number' ? parsed.w : DEFAULT_W,
          chat: parsed.chat === true,
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

export const STREAM_DOCK_EVENT = 'bp-stream-dock';

export function isStreamDockDismissed(slug: string): boolean {
  return readSaved(slug).dismissed;
}

export function showStreamDock(slug: string) {
  const cur = readSaved(slug);
  try {
    localStorage.setItem(
      storageKey(slug),
      JSON.stringify({ ...cur.layout, docked: cur.docked, dismissed: false }),
    );
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(STREAM_DOCK_EVENT, { detail: { slug } }));
}

export function StreamDockRestoreButton({
  slug,
  onShown,
}: {
  slug: string;
  onShown?: () => void;
}) {
  const [hidden, setHidden] = useState(() =>
    typeof window === 'undefined' ? false : isStreamDockDismissed(slug),
  );
  useEffect(() => {
    const sync = (e?: Event) => {
      const from = (e as CustomEvent<{ slug?: string }> | undefined)?.detail?.slug;
      if (from && from !== slug) return;
      setHidden(isStreamDockDismissed(slug));
    };
    window.addEventListener(STREAM_DOCK_EVENT, sync);
    return () => window.removeEventListener(STREAM_DOCK_EVENT, sync);
  }, [slug]);
  if (!hidden) return null;
  return (
    <button
      type="button"
      className="mt-2 flex w-full items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px] font-bold text-fg hover:bg-fill-weak"
      onClick={() => {
        showStreamDock(slug);
        onShown?.();
      }}
    >
      <IconTwitch size={15} className="opacity-80" />
      Show live stream
    </button>
  );
}

function resizeFrom(orig: Layout, corner: Corner, dx: number, dy: number): Layout {
  const origBox = boxSize(orig, true);
  const fromX = corner === 'ne' || corner === 'se' ? dx : -dx;
  const fromY = corner === 'sw' || corner === 'se' ? dy * ASPECT : -dy * ASPECT;
  const dw = Math.abs(fromX) >= Math.abs(fromY) ? fromX : fromY;
  const w = Math.min(maxW(orig.chat), Math.max(MIN_W, orig.w + dw));
  const next = { ...orig, w };
  const nextBox = boxSize(next, true);
  if (corner === 'nw' || corner === 'sw') next.x = orig.x + origBox.w - nextBox.w;
  if (corner === 'nw' || corner === 'ne') next.y = orig.y + origBox.h - nextBox.h;
  return clampLayout(next, true);
}

function twitchParent() {
  return window.location.hostname || 'localhost';
}

function twitchSrc(channel: string): string {
  const q = new URLSearchParams({
    channel,
    parent: twitchParent(),
    muted: 'true',
    autoplay: 'true',
  });
  return `https://player.twitch.tv/?${q.toString()}`;
}

function twitchChatSrc(channel: string): string {
  const q = new URLSearchParams({
    parent: twitchParent(),
    darkpopout: '',
  });
  return `https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat?${q.toString()}`;
}

const CORNERS: { corner: Corner; className: string; style: { cursor: string; top?: number } }[] = [
  { corner: 'nw', className: 'left-0', style: { cursor: 'nwse-resize', top: HEADER_H } },
  { corner: 'ne', className: 'right-0', style: { cursor: 'nesw-resize', top: HEADER_H } },
  { corner: 'sw', className: 'bottom-0 left-0', style: { cursor: 'nesw-resize' } },
  { corner: 'se', className: 'bottom-0 right-0', style: { cursor: 'nwse-resize' } },
];

export function StreamDock({
  slug,
  channel,
  slotRef,
}: {
  slug: string;
  channel: string;
  slotRef: RefObject<HTMLElement | null>;
}) {
  const saved =
    typeof window === 'undefined'
      ? { layout: defaultLayout(), docked: true, dismissed: false }
      : readSaved(slug);
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const [docked, setDocked] = useState(saved.docked);
  const [dismissed, setDismissed] = useState(saved.dismissed);
  const dismissedRef = useRef(saved.dismissed);
  const [layout, setLayout] = useState<Layout>(saved.layout);
  const gesture = useRef<Gesture | null>(null);
  const [busy, setBusy] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const fab = narrow && !expanded;

  useLayoutEffect(() => {
    setSlotEl(slotRef.current);
  }, [slotRef]);

  const statusQ = useQuery({
    queryKey: ['tenant-stream', slug],
    queryFn: () => fetchTenantStream(slug),
    refetchInterval: 45_000,
    staleTime: 20_000,
  });
  const live = statusQ.data?.live ?? null;
  const title = statusQ.data?.title;
  const showPlayer = expanded && live !== false;
  const beside = chatBeside(layout.chat);
  const size = boxSize(layout, expanded, fab);
  const headerChip = !narrow && docked && !expanded;
  const floating = !headerChip;

  const persist = useCallback(
    (next: Layout, nextDocked: boolean, nextDismissed?: boolean) => {
      const dismissedVal = nextDismissed ?? dismissedRef.current;
      try {
        localStorage.setItem(
          storageKey(slug),
          JSON.stringify({ ...next, docked: nextDocked, dismissed: dismissedVal }),
        );
      } catch {
        /* ignore */
      }
    },
    [slug],
  );

  useEffect(() => {
    const on = (e: Event) => {
      const from = (e as CustomEvent<{ slug?: string }>).detail?.slug;
      if (from && from !== slug) return;
      const next = isStreamDockDismissed(slug);
      dismissedRef.current = next;
      setDismissed(next);
    };
    window.addEventListener(STREAM_DOCK_EVENT, on);
    return () => window.removeEventListener(STREAM_DOCK_EVENT, on);
  }, [slug]);

  useEffect(() => {
    const fit = () => {
      if (narrow && !expanded) {
        setLayout((l) => {
          const origin = docked ? defaultFabOrigin() : l;
          return clampLayout({ ...l, ...origin }, false, true);
        });
        return;
      }
      if (docked) {
        const origin = slotOrigin(slotEl, expanded);
        if (origin && expanded) {
          setLayout((l) => clampLayout({ ...l, ...origin }, true));
          return;
        }
      }
      setLayout((l) => clampLayout(l, expanded));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [expanded, layout.chat, docked, slotEl, narrow]);

  const endGesture = (el: HTMLElement, pointerId: number) => {
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    setBusy(false);
  };

  const onMoveDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      kind: 'move',
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      orig: layout,
      moved: false,
    };
    setBusy(true);
  };

  const onResizeDown = (corner: Corner) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = {
      kind: 'resize',
      pointerId: e.pointerId,
      corner,
      startX: e.clientX,
      startY: e.clientY,
      orig: layout,
    };
    setBusy(true);
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === 'resize') {
      setLayout(resizeFrom(g.orig, g.corner, dx, dy));
      return;
    }
    if (!g.moved && dx * dx + dy * dy < DRAG_PX * DRAG_PX) return;
    g.moved = true;
    if (docked) setDocked(false);
    setLayout(clampLayout({ ...g.orig, x: g.orig.x + dx, y: g.orig.y + dy }, expanded, fab));
  };

  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    endGesture(e.currentTarget as HTMLElement, e.pointerId);
    if (g.kind === 'resize') {
      setLayout((l) => {
        const next = clampLayout(l, true);
        persist(next, docked);
        return next;
      });
      return;
    }
    if (g.moved) {
      setLayout((l) => {
        const next = clampLayout(l, expanded, fab);
        persist(next, false);
        return next;
      });
      setDocked(false);
      return;
    }
    if (!expanded) {
      if (narrow) {
        setLayout((l) => clampLayout({ ...l, x: PAD, y: Math.max(PAD, Math.min(l.y, 72)) }, true));
      } else {
        const origin = docked ? slotOrigin(slotEl, true) : null;
        if (origin) setLayout((l) => clampLayout({ ...l, ...origin }, true));
      }
      setExpanded(true);
    }
  };

  const toggleDock = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (docked) {
      const origin = slotOrigin(slotEl, false);
      const next = clampLayout({ ...layout, ...(origin ?? {}) }, expanded);
      setDocked(false);
      setLayout(next);
      persist(next, false);
      return;
    }
    setDocked(true);
    persist(layout, true);
    if (expanded) setExpanded(false);
  };

  const toggleChat = () => {
    setLayout((l) => {
      const next = clampLayout({ ...l, chat: !l.chat }, true);
      persist(next, docked);
      return next;
    });
  };

  const liveLabel = live === true ? 'LIVE' : live === false ? 'Offline' : 'Twitch';
  const frameEvents = busy ? 'none' : 'auto';
  const chatFrame =
    expanded && layout.chat ? (
      <iframe
        title={`${channel} Twitch chat`}
        src={twitchChatSrc(channel)}
        className="block bg-sunken"
        style={{
          width: beside ? CHAT_W : layout.w,
          height: beside ? vidH(layout.w) : CHAT_STACK_H,
          pointerEvents: frameEvents,
        }}
      />
    ) : null;

  const lockBtn = narrow ? null : (
    <button
      type="button"
      title={docked ? 'Undock to drag' : 'Dock next to Buy'}
      aria-label={docked ? 'Undock stream' : 'Dock stream'}
      className="inline-flex size-3.5 shrink-0 items-center justify-center overflow-hidden text-white/80 hover:text-white"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggleDock}
    >
      {docked ? <IconUnlock size={12} /> : <IconLock size={12} />}
    </button>
  );

  const openFromDock = () => {
    const origin = slotOrigin(slotEl, true);
    if (origin) setLayout((l) => clampLayout({ ...l, ...origin }, true));
    setExpanded(true);
  };

  const chip = (
    <div
      role="button"
      tabIndex={0}
      className={`relative inline-flex touch-none items-center justify-center overflow-hidden text-white shadow-lg ${
        fab
          ? 'size-11 cursor-grab rounded-full active:cursor-grabbing'
          : `gap-1.5 rounded-full px-[0.9rem] py-[0.4rem] text-[12px] font-extrabold leading-none ${
              headerChip ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
            }`
      }`}
      style={{ background: TWITCH }}
      aria-label={`${liveLabel}. ${headerChip ? 'Tap to open.' : 'Drag to move, tap to open.'}`}
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
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          live === true ? 'animate-pulse bg-[#eb0400]' : 'bg-white/55'
        } ${fab ? 'absolute right-2 top-2' : ''}`}
      />
      <IconTwitch size={fab ? 18 : 13} className="text-white" />
      {fab ? null : <span className="text-[12px] font-extrabold leading-none text-white">{liveLabel}</span>}
      {fab ? null : lockBtn}
    </div>
  );

  const dockedChip = slotEl && headerChip ? createPortal(chip, slotEl) : null;

  return (
    <>
      {dockedChip}
      {floating && !(narrow && dismissed && !expanded) ? (
        <div
          className="fixed z-[45] select-none"
          style={{
            left: layout.x,
            top: layout.y,
            width: expanded ? size.w : undefined,
            height: expanded ? size.h : undefined,
          }}
        >
          {expanded ? (
            <div className="relative h-full overflow-hidden rounded-xl border border-stroke-weak bg-background shadow-lg">
              <div
                className="flex h-9 cursor-grab touch-none items-center gap-1.5 px-2 active:cursor-grabbing"
                style={{ background: TWITCH }}
                onPointerDown={onMoveDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    live === true ? 'animate-pulse bg-[#eb0400]' : 'bg-white/55'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-white">
                  {live === true ? 'LIVE' : 'Twitch'}
                  {title ? <span className="ml-1 font-semibold text-white/75">{title}</span> : null}
                </span>
                {lockBtn}
                <button
                  type="button"
                  className={`shrink-0 text-[10px] font-bold ${
                    layout.chat ? 'text-white' : 'text-white/70 hover:text-white'
                  }`}
                  aria-pressed={layout.chat}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={toggleChat}
                >
                  Chat
                </button>
                <a
                  href={`https://www.twitch.tv/${encodeURIComponent(channel)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-[10px] font-bold text-white/70 hover:text-white"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Open
                </a>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/80 hover:bg-white/15 hover:text-white"
                  aria-label="Collapse stream"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setExpanded(false)}
                >
                  <IconClose size={12} />
                </button>
              </div>
              <div className={beside ? 'flex' : ''}>
                {showPlayer ? (
                  <iframe
                    title={`${channel} on Twitch`}
                    src={twitchSrc(channel)}
                    className="block bg-black"
                    style={{
                      width: layout.w,
                      height: vidH(layout.w),
                      pointerEvents: frameEvents,
                    }}
                    allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                    allowFullScreen
                    referrerPolicy="origin"
                  />
                ) : (
                  <div
                    className="flex items-center justify-center bg-sunken text-[12px] font-bold text-fg-subtle"
                    style={{ width: layout.w, height: vidH(layout.w) }}
                  >
                    Offline
                  </div>
                )}
                {chatFrame}
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
                  aria-label="Hide live stream"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissedRef.current = true;
                    setDismissed(true);
                    persist(layout, docked, true);
                    window.dispatchEvent(new CustomEvent(STREAM_DOCK_EVENT, { detail: { slug } }));
                  }}
                >
                  <IconClose size={11} />
                </button>
              ) : null}
            </div>
          )}
          {expanded
            ? CORNERS.map(({ corner, className, style }) => (
                <div
                  key={corner}
                  role="separator"
                  aria-label="Resize stream"
                  aria-orientation="horizontal"
                  className={`absolute z-10 h-5 w-5 touch-none ${className}`}
                  style={style}
                  onPointerDown={onResizeDown(corner)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  <span
                    className={`pointer-events-none absolute h-2 w-2 border-white/70 ${
                      corner === 'se'
                        ? 'bottom-1 right-1 rounded-br-sm border-b-2 border-r-2'
                        : corner === 'sw'
                          ? 'bottom-1 left-1 rounded-bl-sm border-b-2 border-l-2'
                          : corner === 'ne'
                            ? 'right-1 top-1 rounded-tr-sm border-r-2 border-t-2'
                            : 'left-1 top-1 rounded-tl-sm border-l-2 border-t-2'
                    }`}
                  />
                </div>
              ))
            : null}
        </div>
      ) : null}
    </>
  );
}
