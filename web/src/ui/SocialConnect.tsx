import { useState } from 'react';
import type { SocialProvider, VerifiedSocials } from '../lib/auth';
import { normalizeWebsiteUrl, websiteError } from '../lib/tenants';
import {
  IconCheck,
  IconDiscord,
  IconGlobe,
  IconInstagram,
  IconTelegram,
  IconTikTok,
  IconTwitch,
  IconX,
  IconYouTube,
} from './icons';

type SocialRow = {
  id: SocialProvider;
  label: string;
  Icon: typeof IconX;
  prefix: string;
  hint: string;
  /** Shown at the bottom with a Soon badge — connect not offered yet. */
  soon?: boolean;
};

const ROWS: SocialRow[] = [
  { id: 'twitter', label: 'X', Icon: IconX, prefix: '@', hint: 'Sign in with X to prove it’s yours' },
  { id: 'youtube', label: 'YouTube', Icon: IconYouTube, prefix: '', hint: 'Same as Google login — connect Google to verify' },
  { id: 'twitch', label: 'Twitch', Icon: IconTwitch, prefix: '', hint: 'Sign in with Twitch to prove it’s yours' },
  { id: 'discord', label: 'Discord', Icon: IconDiscord, prefix: '', hint: 'Sign in with Discord to prove it’s yours' },
  { id: 'tiktok', label: 'TikTok', Icon: IconTikTok, prefix: '@', hint: 'Coming soon', soon: true },
  { id: 'instagram', label: 'Instagram', Icon: IconInstagram, prefix: '@', hint: 'Coming soon', soon: true },
  // linkTelegram / unlink still wired in auth.tsx — re-enable Connect when ready.
  { id: 'telegram', label: 'Telegram', Icon: IconTelegram, prefix: '@', hint: 'Coming soon', soon: true },
];

/**
 * Socials are connect-only. A handle appears here only after Privy OAuth put it
 * on the account, so nobody can type in someone else's @. Website is optional
 * free text but must be https + a real domain.
 * YouTube uses Google. Twitch / Telegram use Privy’s native providers (web).
 */
export function SocialConnect({
  socials,
  show,
  onToggle,
  onConnect,
  onDisconnect,
  website,
  onWebsite,
  error,
}: {
  socials: VerifiedSocials;
  show: Record<SocialProvider, boolean>;
  onToggle: (p: SocialProvider, on: boolean) => void;
  onConnect: (p: SocialProvider) => void;
  onDisconnect: (p: SocialProvider) => Promise<void>;
  website: string;
  onWebsite: (v: string) => void;
  error: string | null;
}) {
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const siteErr = websiteError(website);

  const disconnect = async (id: SocialProvider) => {
    setBusy(id);
    try {
      await onDisconnect(id);
    } finally {
      setBusy(null);
    }
  };

  const rows = ROWS;

  return (
    <div className="grid gap-2">
      {rows.map(({ id, label, Icon, prefix, hint, soon }) => {
        const handle = socials[id];
        const on = !!handle && show[id];
        return (
          <div
            key={id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 px-3 py-2.5 ${
              on
                ? 'border-success/60 bg-success/5'
                : soon
                  ? 'border-stroke-weak bg-fill-weak/40 opacity-80'
                  : 'border-stroke-weak bg-background'
            }`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-fill-weak">
                <Icon size={15} />
              </span>
              <div className="min-w-0 shrink">
                <div className="text-[13px] font-bold">{label}</div>
                {!handle ? <div className="text-[11px] text-fg-subtle">{hint}</div> : null}
              </div>
              {handle ? (
                <>
                  <span className="tag-ok shrink-0" title="Verified">
                    <IconCheck size={9} />
                    <span className="hidden sm:inline"> verified</span>
                  </span>
                  <div className="min-w-0 truncate text-[12px] font-semibold text-fg-muted">
                    {prefix}
                    {handle}
                  </div>
                </>
              ) : null}
            </div>
            {soon && !handle ? (
              <span className="shrink-0 rounded-md border border-stroke-weak bg-background px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-fg-subtle">
                Soon
              </span>
            ) : handle ? (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className={`btn-ghost btn-sm px-3 py-1.5 text-[12px] ${
                    show[id] ? '!border-[var(--text-brand)] text-brand' : ''
                  }`}
                  aria-pressed={show[id]}
                  onClick={() => onToggle(id, !show[id])}
                >
                  Show
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm px-3 py-1.5 text-[12px]"
                  disabled={busy === id}
                  onClick={() => void disconnect(id)}
                >
                  {busy === id ? '…' : 'Disconnect'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0 px-3 py-1.5 text-[12px]"
                onClick={() => onConnect(id)}
              >
                Connect
              </button>
            )}
          </div>
        );
      })}

      <label className="mt-1 block">
        <span className="label">
          <IconGlobe size={13} />
          Website <span className="opt">optional</span>
        </span>
        <input
          className="field mt-1.5"
          value={website}
          onChange={(e) => onWebsite(e.target.value.slice(0, 200))}
          onBlur={() => {
            if (!website.trim() || websiteError(website)) return;
            try {
              onWebsite(normalizeWebsiteUrl(website));
            } catch {
              /* keep typed value */
            }
          }}
          placeholder="https://example.com"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
        />
        {siteErr ? <p className="mt-1 text-[12px] font-semibold text-error">{siteErr}</p> : null}
      </label>
      {error ? <p className="text-[12px] font-semibold text-error">{error}</p> : null}
    </div>
  );
}
