import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebAuth } from '../lib/auth';
import { patchTenant } from '../lib/api';
import type { TenantPublic } from '../lib/tenants';
import { IconTwitch } from './icons';

/**
 * Live apps freeze socials, but an empty Twitch handle may be filled from the
 * current Privy login so the public banner can show the same icon as X / Discord.
 */
export function useSyncTenantTwitch(tenant: TenantPublic | undefined, enabled = true) {
  const { getAccessToken, socials } = useWebAuth();
  const qc = useQueryClient();
  const ran = useRef<string>('');

  useEffect(() => {
    if (!enabled || !tenant) return;
    const fromPrivy = (socials.twitch || '').replace(/^@/, '').toLowerCase();
    if (!fromPrivy || tenant.socials.twitch) return;
    const key = `${tenant.id}:${fromPrivy}`;
    if (ran.current === key) return;
    ran.current = key;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        // Connecting Twitch is enough for the desk button — turn the overlay on.
        const next = await patchTenant(tenant.slug, { stream: { twitch: true } }, token);
        void qc.setQueryData(['my-tenants'], (cur: TenantPublic[] | undefined) =>
          Array.isArray(cur) ? cur.map((row) => (row.id === next.id ? next : row)) : cur,
        );
        void qc.invalidateQueries({ queryKey: ['my-tenants'] });
        void qc.invalidateQueries({ queryKey: ['tenant', tenant.slug] });
      } catch {
        ran.current = '';
      }
    })();
  }, [enabled, tenant, socials.twitch, getAccessToken, qc]);
}

/**
 * Live-app setting. Identity (the Twitch handle) stays Privy-verified;
 * this opts the desk overlay on or off. Connecting Twitch turns it on.
 */
export function StreamDeskCard({ tenant }: { tenant: TenantPublic }) {
  const { getAccessToken, socials, linkSocial } = useWebAuth();
  useSyncTenantTwitch(tenant);
  const qc = useQueryClient();
  const handle = (tenant.socials.twitch || socials.twitch || '').replace(/^@/, '');
  const on = !!tenant.stream?.twitch;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (twitch: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const next = await patchTenant(tenant.slug, { stream: { twitch } }, token);
      void qc.setQueryData(['my-tenants'], (cur: TenantPublic[] | undefined) =>
        Array.isArray(cur) ? cur.map((row) => (row.id === next.id ? next : row)) : cur,
      );
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      void qc.invalidateQueries({ queryKey: ['tenant', tenant.slug] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[12px] font-extrabold text-fg">
          <IconTwitch size={13} className="text-brand" />
          Show live stream in your app
        </div>
        <p className="mt-0.5 text-[11px] text-fg-subtle">
          {handle ? (
            <>
              Twitch control on the trading terminal — header chip on desktop, floating button on phones.
              Channel is <span className="font-semibold text-fg-muted">{handle}</span>. On when you
              connect Twitch; turn off here to hide it.
            </>
          ) : (
            'Connect Twitch first — the terminal stream button appears as soon as it is linked.'
          )}
        </p>
        {error ? <p className="mt-1 text-[11px] font-semibold text-error">{error}</p> : null}
      </div>
      {handle ? (
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-2">
          <span className="text-[11px] font-bold text-fg-subtle">{on ? 'On' : 'Off'}</span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--text-brand)]"
            checked={on}
            disabled={busy}
            onChange={(e) => {
              e.stopPropagation();
              void save(e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </label>
      ) : (
        <button
          type="button"
          className="btn-ghost btn-sm shrink-0 px-3 py-1.5 text-xs"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            linkSocial('twitch');
          }}
        >
          Connect Twitch
        </button>
      )}
    </div>
  );
}
