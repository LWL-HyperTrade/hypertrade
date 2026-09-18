import { consoleHref, tenantAppHref } from '../lib/config';
import { creatorLabel, creatorOtherApps, type TenantCreator, type TenantPublic } from '../lib/tenants';
import { AppHref } from './AppHref';
import { IconDiscord, IconInstagram, IconTelegram, IconTikTok, IconTwitch, IconX, IconYouTube } from './icons';

const KIND_ICON = {
  twitter: IconX,
  telegram: IconTelegram,
  twitch: IconTwitch,
  youtube: IconYouTube,
  tiktok: IconTikTok,
  instagram: IconInstagram,
  discord: IconDiscord,
} as const;

/** Explore filtered to one creator. Absolute from a branded host so the console router handles it. */
export function creatorExploreHref(c: TenantCreator): string {
  return consoleHref(`/explore?creator=${encodeURIComponent(c.key)}`);
}

/**
 * `by @handle · 3 apps` — only for creators with a verified social AND more
 * than one live app. Single-app or unverified creators render nothing, so the
 * directory stays quiet.
 */
export function CreatorByline({
  creator,
  className = '',
  linkTo = 'explore',
}: {
  creator: TenantCreator | null | undefined;
  className?: string;
  /** `explore` filters the directory; `none` renders plain text. */
  linkTo?: 'explore' | 'none';
}) {
  if (!creator || creator.apps.length < 2) return null;
  const Icon = KIND_ICON[creator.kind] ?? IconX;
  const label = creatorLabel(creator);
  const body = (
    <>
      <span className="text-fg-subtle">by</span>
      <Icon size={10} className="shrink-0 opacity-70" />
      <span className="truncate font-bold text-fg-muted">{label}</span>
      <span className="text-fg-subtle">· {creator.apps.length} apps</span>
    </>
  );
  const cls = `inline-flex min-w-0 max-w-full items-center gap-1 text-[11px] font-semibold ${className}`;
  if (linkTo === 'none') return <span className={cls}>{body}</span>;
  return (
    <AppHref to={creatorExploreHref(creator)} className={`${cls} rounded-md hover:text-brand`} aria-label={`All apps by ${label}`}>
      {body}
    </AppHref>
  );
}

/**
 * "More from @handle" strip for the creator page. Compact chips of the
 * creator's other live apps. Hidden when there are none.
 */
export function MoreFromCreator({ tenant }: { tenant: TenantPublic }) {
  const creator = tenant.creator;
  const others = creatorOtherApps(creator, tenant.slug);
  if (!creator || !others.length) return null;
  const label = creatorLabel(creator);
  return (
    <section className="creator-section mt-8 sm:mt-10">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">Same creator</div>
          <h2 className="mt-1 text-xl font-black tracking-tight sm:text-2xl">More from {label}</h2>
        </div>
        <AppHref to={creatorExploreHref(creator)} className="text-[12px] font-bold text-brand hover:underline">
          All {creator.apps.length} apps →
        </AppHref>
      </div>
      <ul className="mt-4 flex flex-wrap gap-2">
        {others.map((a) => (
          <li key={a.slug}>
            <AppHref
              to={tenantAppHref(a.slug)}
              className="flex items-center gap-2.5 rounded-xl border border-stroke-weak bg-surface px-3 py-2 hover:bg-fill-weaker"
            >
              {a.logo_url ? (
                <img src={a.logo_url} alt="" className="h-8 w-8 rounded-lg object-cover" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-[12px] font-black text-brand">
                  {(a.app_name || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-extrabold">{a.app_name}</span>
                <span className="block truncate text-[11px] font-bold text-fg-subtle">
                  {a.coin_symbol ? `$${a.coin_symbol.toUpperCase()}` : `@${a.slug}`}
                </span>
              </span>
            </AppHref>
          </li>
        ))}
      </ul>
    </section>
  );
}
