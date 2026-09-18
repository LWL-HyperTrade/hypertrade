import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useWebAuth } from '../lib/auth';
import { assignTenantDomain, removeTenantDomain, verifyTenantDomain } from '../lib/api';
import type { TenantPublic } from '../lib/tenants';
import { IconCheck, IconClose, IconCopy, IconGlobe } from './icons';

/** Live + activated only. Opens the DNS popup. Preview apps get no badge. */
export function CustomDomainBadge({ tenant }: { tenant: TenantPublic }) {
  const [open, setOpen] = useState(false);
  const verified = !!tenant.domain?.verified;
  return (
    <>
      <button
        type="button"
        className={`inline-flex items-center gap-0.5 ${
          verified
            ? 'tag-ok'
            : 'rounded-full bg-fill-weak px-2 py-0.5 text-[10px] font-extrabold text-fg-muted hover:bg-fill-hover hover:text-fg'
        }`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <IconGlobe size={9} /> Your own domain
      </button>
      {open ? <CustomDomainDialog tenant={tenant} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CustomDomainDialog({ tenant, onClose }: { tenant: TenantPublic; onClose: () => void }) {
  const { getAccessToken } = useWebAuth();
  const qc = useQueryClient();
  const [view, setView] = useState(tenant);
  const domain = view.domain;
  const [host, setHost] = useState(domain?.host ?? '');
  const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setView((cur) => {
      if (cur.id === tenant.id && cur.domain && !tenant.domain) return cur;
      return tenant;
    });
    if (tenant.domain?.host) setHost(tenant.domain.host);
  }, [tenant]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = (next: TenantPublic) => {
    setView(next);
    if (next.domain?.host) setHost(next.domain.host);
    void qc.setQueryData(['my-tenants'], (cur: TenantPublic[] | undefined) =>
      Array.isArray(cur) ? cur.map((row) => (row.id === next.id ? next : row)) : cur,
    );
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
  };

  const withToken = async (fn: (token: string) => Promise<TenantPublic>, kind: typeof busy) => {
    setError(null);
    setBusy(kind);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const next = await fn(token);
      if (kind === 'save' && !next.domain) {
        throw new Error('Saved, but DNS records did not load. Try Show DNS records again.');
      }
      refresh(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void withToken((token) => assignTenantDomain(tenant.slug, host, token), 'save');
  };

  return (
    <Overlay onClose={onClose} title="Your own domain">
      {domain?.verified ? (
        <>
          <p className="text-[13px] leading-5 text-fg-muted">
            Fans can use this address. The BuilderPad link still works.
          </p>
          <a
            href={`https://${domain.host}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block truncate text-[14px] font-bold text-brand"
          >
            {domain.host}
          </a>
          {error ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}
          <button
            type="button"
            className="btn-ghost btn-sm mt-4 px-3 py-1.5 text-xs"
            disabled={busy !== null}
            onClick={() => void withToken((token) => removeTenantDomain(tenant.slug, token), 'remove')}
          >
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </>
      ) : domain ? (
        <>
          <HowItWorks />
          <DnsRow
            label="1. TXT · ownership"
            name={domain.txt_short}
            fallback={domain.txt_name}
            value={domain.txt_value}
            hint={`Paste as a TXT record. Host is ${domain.txt_short}, not ${domain.cname_short}.`}
          />
          <DnsRow
            label="2. CNAME · the site"
            name={domain.cname_short}
            fallback={domain.cname_name}
            value={domain.cname_target}
            hint={`This one is just ${domain.cname_short} — that is the address fans open.`}
          />
          {error ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary btn-sm px-3 py-1.5 text-xs"
              disabled={busy !== null}
              onClick={() => void withToken((token) => verifyTenantDomain(tenant.slug, token), 'check')}
            >
              {busy === 'check' ? 'Checking…' : 'Check DNS'}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm px-3 py-1.5 text-xs"
              disabled={busy !== null}
              onClick={() => void withToken((token) => removeTenantDomain(tenant.slug, token), 'remove')}
            >
              {busy === 'remove' ? 'Removing…' : 'Start over'}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <p className="text-[13px] leading-5 text-fg-muted">
            Use a name for a domain you own — trade, app, anything. Say you own mydomain.com, you can use trade.mydomain.com, app.mydomain.com, etc.
          </p>
          <label className="mt-3 block text-[11px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
            Address
            <input
              className="mt-1 w-full rounded-lg border border-stroke-strong bg-sunken px-3 py-2 font-mono text-[13px] text-fg"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="trade.yourdomain.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          {error ? <p className="mt-2 text-[12px] font-semibold text-error">{error}</p> : null}
          <button
            type="submit"
            className="btn-primary btn-sm mt-4 px-3 py-1.5 text-xs"
            disabled={busy !== null || !host.trim()}
          >
            {busy === 'save' ? 'Saving…' : 'Show DNS records'}
          </button>
        </form>
      )}
    </Overlay>
  );
}

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-labelledby="domain-dialog-title"
        className="card-pop max-h-[min(90dvh,40rem)] w-full max-w-md overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="domain-dialog-title" className="text-[15px] font-extrabold">
            {title}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function DnsRow({
  label,
  name,
  fallback,
  value,
  hint,
}: {
  label: string;
  name: string;
  fallback: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="mt-3 rounded-xl border border-stroke-weak bg-sunken px-3 py-2.5">
      <div className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-fg-subtle">{label}</div>
      {hint ? <p className="mt-1 text-[12px] leading-4 text-fg-muted">{hint}</p> : null}
      <CopyField k="Type" value={label.includes('TXT') ? 'TXT' : 'CNAME'} />
      <CopyField k="Name / Host" value={name} />
      <CopyField k="Value" value={value} />
      <p className="mt-1.5 text-[11px] leading-4 text-fg-subtle">
        If it rejects that name, try the full one: <span className="font-mono">{fallback}</span>
      </p>
    </div>
  );
}

function CopyField({ k, value }: { k: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] font-bold text-fg-subtle">{k}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{value}</code>
      <button
        type="button"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
        aria-label={copied ? 'Copied' : `Copy ${k}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
      </button>
    </div>
  );
}

function HowItWorks() {
  return (
    <details className="mt-3 rounded-xl border border-stroke-weak px-3 py-2">
      <summary className="cursor-pointer text-[12px] font-extrabold text-fg">How it works</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-5 text-fg-muted">
        <li>Open the site where you bought the domain (GoDaddy, Namecheap, Google, Cloudflare…).</li>
        <li>Find DNS or Advanced DNS.</li>
        <li>Add the two records below. Paste them.</li>
        <li>Save. Wait 1–10 minutes (sometimes up to an hour).</li>
        <li>Come back here and tap Check DNS.</li>
      </ol>
      <p className="mt-2 text-[12px] leading-5 text-fg-subtle">
        trade. is just an example. app. or www. is fine. Cloudflare: click the orange cloud so it turns
        grey (DNS only).
      </p>
    </details>
  );
}
