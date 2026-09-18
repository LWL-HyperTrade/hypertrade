import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { robinhoodTokenUrl, robinhoodTxUrl } from '../lib/pons';
import type { TenantPublic } from '../lib/tenants';
import { TENANT_BASE_DOMAIN, tenantPublicUrl } from '../lib/config';
import { IconCheck, IconClose, IconCoin, IconCopy, IconExternal, IconLayers, IconRocket, IconX } from './icons';

type Props = {
  tenant: TenantPublic;
  /** True when the token was deployed in this same run (shows the receipt). */
  tokenLaunched: boolean;
  onOpenApp: () => void;
  onMyApps: () => void;
  onClose: () => void;
};

function shareText(t: TenantPublic, withToken: boolean): string {
  const url = tenantPublicUrl(t.slug);
  const sym = t.coin?.symbol ? `$${t.coin.symbol.toUpperCase()}` : '';
  const line = withToken && sym ? `${t.app_name} is live — trade the app, hold ${sym}.` : `${t.app_name} is live.`;
  return `${line}\n${url}`;
}

/** Shown once after publish (with or without a token). Ends the wizard on a high note. */
export function LaunchSuccessModal({ tenant, tokenLaunched, onOpenApp, onMyApps, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const host = `${tenant.slug}.${TENANT_BASE_DOMAIN}`;
  const url = tenantPublicUrl(tenant.slug);
  const coin = tokenLaunched ? tenant.coin : null;
  const symbol = coin?.symbol?.toUpperCase() || tenant.coin?.symbol?.toUpperCase() || null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the chip still shows the URL */
    }
  };

  const share = () => {
    const intent = `https://x.com/intent/post?text=${encodeURIComponent(shareText(tenant, !!coin))}`;
    window.open(intent, '_blank', 'noopener,noreferrer');
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" className="absolute inset-0 bg-sunken/80" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-success-title"
        className="launch-success relative z-10 max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-stroke-weak bg-overlay p-5 text-fg sm:rounded-2xl sm:p-6"
      >
        <button
          type="button"
          className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle hover:bg-fill-weaker hover:text-fg"
          aria-label="Close"
          onClick={onClose}
        >
          <IconClose size={16} />
        </button>

        <div className="flex flex-col items-center text-center">
          <div className="launch-success-logo relative">
            {tenant.logo_url ? (
              <img
                src={tenant.logo_url}
                alt=""
                className="h-20 w-20 rounded-2xl border-2 border-stroke-strong object-cover"
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-stroke-strong bg-fill-weaker text-3xl font-black">
                {(tenant.app_name || '?').trim().charAt(0).toUpperCase()}
              </div>
            )}
            <span className="absolute -bottom-2 -right-2 inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-overlay bg-market-up text-black">
              <IconCheck size={14} />
            </span>
          </div>

          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-market-up/40 bg-market-up/10 px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-market-up">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-market-up" /> Live
          </div>

          <h2 id="launch-success-title" className="display mt-3 text-3xl sm:text-4xl">
            <span className="text-hype">{tenant.app_name}</span> is live
          </h2>
          <p className="mt-2 max-w-xs text-[13px] leading-5 text-fg-muted">
            {coin
              ? `Your app and $${symbol} are out. Every trade on the app pays your builder fee; the token is on Pons.`
              : 'Your app is out. Every trade pays your builder fee. You can launch a token any time from My apps.'}
          </p>
        </div>

        <div className="mt-5 flex items-center gap-2 rounded-xl bg-fill-weaker px-3 py-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate font-mono text-[12px] font-bold text-fg hover:text-brand"
          >
            {host}
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in new tab"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
          >
            <IconExternal size={14} />
          </a>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
            aria-label={copied ? 'Copied' : 'Copy link'}
            onClick={() => void copy()}
          >
            {copied ? <IconCheck size={14} className="text-success" /> : <IconCopy size={14} />}
          </button>
        </div>

        {coin ? (
          <div className="mt-3 rounded-xl border border-stroke-weak px-3 py-2.5 text-[12px]">
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
              <IconCoin size={12} className="text-brand" /> ${symbol} · Robinhood Chain
            </div>
            <div className="mt-1.5 grid gap-1 font-mono text-[11px] text-fg-muted">
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-fg-subtle">token</span>
                <a className="truncate text-fg hover:text-brand" href={robinhoodTokenUrl(coin.token)} target="_blank" rel="noreferrer">
                  {coin.token}
                </a>
              </div>
              {coin.tx_hash ? (
                <div className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-fg-subtle">tx</span>
                  <a className="truncate text-fg hover:text-brand" href={robinhoodTxUrl(coin.tx_hash)} target="_blank" rel="noreferrer">
                    {coin.tx_hash}
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-2">
          <button type="button" className="btn-primary w-full py-3 text-sm" onClick={onOpenApp}>
            <IconRocket size={15} className="shrink-0" />
            <span className="min-w-0 truncate">Go to {tenant.app_name}</span>
          </button>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost btn-sm py-2.5 text-[12px]" onClick={share}>
              <IconX size={13} /> Share on X
            </button>
            <button type="button" className="btn-ghost btn-sm py-2.5 text-[12px]" onClick={onMyApps}>
              <IconLayers size={13} /> My apps
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
