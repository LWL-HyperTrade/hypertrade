/**
 * React wrapper for the VRM stage (docs/RESIDENTS.md §5).
 *
 * - Poster first; the WebGL canvas mounts only once the element is on screen.
 * - `prefers-reduced-motion` or a load error keeps the poster.
 * - One controller per mount; mood / speaking / pointer are pushed imperatively
 *   so a voice-line refetch never re-creates the renderer.
 */
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ResidentMood } from '../../lib/residents';
import { IDLE_ANIMS } from '../../lib/residents';
import { FALLBACK_ANIM, VrmStageController, type StageStatus } from './vrmScene';

type Props = {
  modelUrl: string | null;
  posterUrl: string | null;
  mood: ResidentMood;
  /** Mouth flap while the newest voice line is being shown. */
  speaking?: boolean;
  /** Profit dance clip (`dance.vrma` / `dance-2.vrma`). Waiting uses IDLE_ANIMS. */
  fallbackAnim?: string;
  /** Waiting clips for this look. Males use spin instead of idle, and omit modelpose. */
  idleAnims?: readonly string[];
  className?: string;
  /** Called with 'ready' once the avatar renders — hide skeletons etc. */
  onStatus?: (status: StageStatus) => void;
};

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function VrmStage({
  modelUrl,
  posterUrl,
  mood,
  speaking = false,
  fallbackAnim = FALLBACK_ANIM,
  idleAnims = IDLE_ANIMS,
  className = '',
  onStatus,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctlRef = useRef<VrmStageController | null>(null);
  const [inView, setInView] = useState(false);
  const [status, setStatus] = useState<StageStatus>('idle');
  const [posterGone, setPosterGone] = useState(false);
  const still = reducedMotion() || !modelUrl;

  // Mount the renderer only when visible.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || still) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [still]);

  // Create / dispose the controller.
  useEffect(() => {
    if (!inView || still || !canvasRef.current) return;
    const ctl = new VrmStageController(canvasRef.current);
    ctlRef.current = ctl;
    ctl.onStatus = (s) => {
      setStatus(s);
      onStatus?.(s);
    };
    const ro = new ResizeObserver(() => ctl.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    ctl.setMood(mood);
    ctl.setFallbackAnim(fallbackAnim);
    ctl.setIdleAnims(idleAnims);
    if (modelUrl) void ctl.load(modelUrl);
    return () => {
      ro.disconnect();
      ctl.dispose();
      ctlRef.current = null;
    };
    // modelUrl / mood changes are pushed below; re-creating on them would flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, still]);

  useEffect(() => {
    const ctl = ctlRef.current;
    if (ctl && modelUrl) void ctl.load(modelUrl);
  }, [modelUrl]);

  useEffect(() => {
    ctlRef.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    ctlRef.current?.setSpeaking(speaking);
  }, [speaking]);

  useEffect(() => {
    ctlRef.current?.setFallbackAnim(fallbackAnim);
  }, [fallbackAnim]);

  useEffect(() => {
    ctlRef.current?.setIdleAnims(idleAnims);
  }, [idleAnims]);

  useEffect(() => {
    if (status === 'ready') {
      const t = window.setTimeout(() => setPosterGone(true), 550);
      return () => window.clearTimeout(t);
    }
    setPosterGone(false);
  }, [status]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 0) return;
    const ctl = ctlRef.current;
    const el = wrapRef.current;
    if (!ctl || !el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    const y = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1);
    ctl.setPointer(x, y);
  };

  const onPointerLeave = () => ctlRef.current?.setPointer(0, 0);

  const showCanvas = inView && !still && status !== 'error';
  const posed = status === 'ready';
  const showPoster = !!posterUrl && !posterGone;

  return (
    <div
      ref={wrapRef}
      // Callers pass `absolute inset-0`; never add `relative` here — both
      // position utilities on one element collapse the box to 0 height.
      className={`overflow-hidden touch-none ${className || 'relative h-full w-full'}`}
      title="Scroll to zoom. Left-drag rotates, right-drag pans. Double-click resets."
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
      data-mood={mood}
      data-stage={showCanvas ? status : 'poster'}
    >
      {showCanvas ? (
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full cursor-grab active:cursor-grabbing" />
      ) : null}
      {showPoster ? (
        <img
          src={posterUrl ?? undefined}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-contain object-bottom transition-opacity duration-500"
          style={{ opacity: posed ? 0 : 1 }}
          draggable={false}
        />
      ) : null}
      {!posterUrl && !showCanvas ? (
        <div className="absolute inset-0 grid place-items-center text-[11px] font-bold text-fg-subtle">
          No avatar yet
        </div>
      ) : null}
    </div>
  );
}
