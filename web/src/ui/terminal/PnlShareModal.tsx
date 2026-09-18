import { useEffect, useState } from 'react';
import { IconClose, IconShare } from '../icons';

export type PnlSharePayload = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  pnlPercent: number;
  entryPrice: number;
  markPrice: number;
  leverage?: number | null;
  appName: string;
  logoUrl?: string | null;
};

const UP = '#77c7af';
const DOWN = '#ff9c9c';
const BRAND = '#4ef2bb';

export function PnlShareModal({
  payload,
  onClose,
}: {
  payload: PnlSharePayload | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!payload) return;
    setErr(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, onClose]);

  if (!payload) return null;

  const profit = payload.pnlPercent >= 0;
  const pct = Number.isFinite(payload.pnlPercent) ? payload.pnlPercent.toFixed(2) : '0.00';
  const color = profit ? UP : DOWN;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const blob = await renderPnlPng(payload);
      const file = new File([blob], `${payload.symbol}-pnl.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${payload.symbol} PnL` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not export image');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/60" aria-label="Close" onClick={onClose} />
      <div className="relative w-full max-w-[360px] rounded-2xl border border-stroke-weak bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-bold">Share PnL</h2>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-fill-weak"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div
          className="relative mx-auto overflow-hidden rounded-[18px] p-4"
          style={{ width: 320, maxWidth: '100%', background: '#0d1117' }}
        >
          <div
            className="pointer-events-none absolute"
            style={{
              right: -60,
              top: -60,
              width: 180,
              height: 180,
              borderRadius: 999,
              background: 'rgba(78, 242, 187, 0.16)',
            }}
          />
          <div
            className="pointer-events-none absolute"
            style={{
              left: -40,
              bottom: -40,
              width: 140,
              height: 140,
              borderRadius: 999,
              background: 'rgba(39, 216, 33, 0.12)',
            }}
          />

          <div className="relative flex items-center gap-2">
            {payload.logoUrl ? (
              <img src={payload.logoUrl} alt="" className="h-8 w-8 rounded-[10px] object-cover" />
            ) : (
              <div
                className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[13px] font-black text-black"
                style={{ background: BRAND }}
              >
                {payload.appName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="truncate text-[16px] font-extrabold text-white">{payload.appName}</span>
          </div>

          <div className="relative mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[18px] font-extrabold text-white">{payload.symbol}</span>
            <span
              className="rounded-full border px-2 py-0.5 text-[11px] font-extrabold"
              style={{
                color,
                borderColor: profit ? 'rgba(119,199,175,0.45)' : 'rgba(255,156,156,0.45)',
                background: profit ? 'rgba(119,199,175,0.15)' : 'rgba(255,156,156,0.15)',
              }}
            >
              {payload.direction}
              {payload.leverage ? ` ${Math.round(payload.leverage)}x` : ''}
            </span>
          </div>

          <div className="relative mt-3">
            <div className="text-[40px] font-black leading-none" style={{ color }}>
              {profit ? '+' : ''}
              {pct}%
            </div>
            <div className="mt-1 text-[12px] font-bold text-white/55">PNL</div>
          </div>

          <div className="relative mt-3.5 grid grid-cols-2 gap-4 border-t border-white/10 pt-2.5">
            <div>
              <div className="text-[11px] font-bold text-white/55">Entry price</div>
              <div className="mt-1 text-[13px] font-bold text-white">
                ${payload.entryPrice.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-bold text-white/55">Mark price</div>
              <div className="mt-1 text-[13px] font-bold text-white">
                ${payload.markPrice.toLocaleString()}
              </div>
            </div>
          </div>

          <div
            className="relative mt-3.5 h-1 rounded-full"
            style={{ background: `linear-gradient(90deg, ${BRAND} 0%, #27d821 55%, ${UP} 100%)` }}
          />
        </div>

        {err ? <p className="mt-2 text-center text-[12px] font-semibold text-market-down">{err}</p> : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="btn-primary mt-4 flex w-full items-center justify-center gap-2 py-2.5 text-[13px] disabled:opacity-50"
        >
          <IconShare size={15} />
          {busy ? 'Preparing…' : 'Share / save image'}
        </button>
      </div>
    </div>
  );
}

async function renderPnlPng(p: PnlSharePayload): Promise<Blob> {
  const W = 640;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  const profit = p.pnlPercent >= 0;
  const color = profit ? UP : DOWN;
  const pct = Number.isFinite(p.pnlPercent) ? p.pnlPercent.toFixed(2) : '0.00';

  ctx.fillStyle = '#0d1117';
  roundRect(ctx, 0, 0, W, H, 36);
  ctx.fill();

  ctx.fillStyle = 'rgba(78, 242, 187, 0.16)';
  ctx.beginPath();
  ctx.arc(W - 40, 40, 160, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(39, 216, 33, 0.12)';
  ctx.beginPath();
  ctx.arc(60, H - 40, 130, 0, Math.PI * 2);
  ctx.fill();

  const logo = await loadLogo(p.logoUrl);
  const lx = 32;
  const ly = 32;
  if (logo) {
    ctx.save();
    roundRect(ctx, lx, ly, 64, 64, 20);
    ctx.clip();
    ctx.drawImage(logo, lx, ly, 64, 64);
    ctx.restore();
  } else {
    ctx.fillStyle = BRAND;
    roundRect(ctx, lx, ly, 64, 64, 20);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = '800 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.appName.slice(0, 1).toUpperCase(), lx + 32, ly + 34);
  }

  ctx.fillStyle = '#fff';
  ctx.font = '800 32px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncate(p.appName, 22), lx + 80, ly + 34);

  ctx.font = '800 36px system-ui, sans-serif';
  ctx.fillText(p.symbol, 32, 140);

  const pill = `${p.direction}${p.leverage ? ` ${Math.round(p.leverage)}x` : ''}`;
  ctx.font = '800 22px system-ui, sans-serif';
  const pillW = ctx.measureText(pill).width + 28;
  const pillX = 32 + ctx.measureText(p.symbol).width + 16;
  ctx.fillStyle = profit ? 'rgba(119,199,175,0.15)' : 'rgba(255,156,156,0.15)';
  roundRect(ctx, pillX, 122, pillW, 36, 18);
  ctx.fill();
  ctx.strokeStyle = profit ? 'rgba(119,199,175,0.45)' : 'rgba(255,156,156,0.45)';
  ctx.lineWidth = 2;
  roundRect(ctx, pillX, 122, pillW, 36, 18);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(pill, pillX + 14, 140);

  ctx.fillStyle = color;
  ctx.font = '900 80px system-ui, sans-serif';
  ctx.fillText(`${profit ? '+' : ''}${pct}%`, 32, 260);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.fillText('PNL', 32, 310);

  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(32, 360);
  ctx.lineTo(W - 32, 360);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText('Entry price', 32, 400);
  ctx.fillText('Mark price', W / 2 + 8, 400);
  ctx.fillStyle = '#fff';
  ctx.font = '700 26px system-ui, sans-serif';
  ctx.fillText(`$${p.entryPrice.toLocaleString()}`, 32, 440);
  ctx.fillText(`$${p.markPrice.toLocaleString()}`, W / 2 + 8, 440);

  const grad = ctx.createLinearGradient(32, 0, W - 32, 0);
  grad.addColorStop(0, BRAND);
  grad.addColorStop(0.55, '#27d821');
  grad.addColorStop(1, UP);
  ctx.fillStyle = grad;
  roundRect(ctx, 32, H - 48, W - 64, 8, 4);
  ctx.fill();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Export failed');
  return blob;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function loadLogo(url?: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
