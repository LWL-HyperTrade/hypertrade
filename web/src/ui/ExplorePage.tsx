import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listTenantDirectory } from '../lib/api';
import { formatCompactUsd } from '../lib/earnings';
import { creatorLabel, displayOrders, displayVolumeUsd, type TenantPublic } from '../lib/tenants';
import { IconClose } from './icons';
import { marketFor, useCoinMarkets, type CoinMarket } from '../lib/useCoinMarkets';
import { earnedFor, useCreatorEarnedUsd } from '../lib/useCreatorEarnedUsd';
import { loginHref, useWebAuth } from '../lib/auth';
import { tenantAppHref } from '../lib/config';
import { IconChart, IconCoin, IconRocket, IconUsers } from './icons';
import { CreatorAppCard } from './CreatorAppCard';
import { HomeFeedSkeleton } from './skeleton';
import exploreBanner from '../assets/images/builderpad-cards-background.webp';

type SortKey = 'mcap' | 'new' | 'trending' | 'volume';

/** First paint; more come in via Show more. */
const PAGE_SIZE = 15;

const SORTS: { id: SortKey; label: string; emoji: string }[] = [
  { id: 'mcap', label: 'Market cap', emoji: '💎' },
  { id: 'new', label: 'New', emoji: '✨' },
  { id: 'trending', label: 'Trending', emoji: '🔥' },
  { id: 'volume', label: 'Volume', emoji: '📈' },
];

function createdMs(t: TenantPublic): number {
  const n = Date.parse(String(t.coin?.launched_at || t.created_at || ''));
  return Number.isFinite(n) ? n : 0;
}

function volumeUsd(t: TenantPublic): number {
  return displayVolumeUsd(t);
}

function mcapUsd(t: TenantPublic, markets: Record<string, CoinMarket> | undefined): number {
  const n = marketFor(markets, t.coin?.token)?.mcapUsd;
  return n != null && Number.isFinite(n) && n > 0 ? n : 0;
}

function uniqueBuilderVolume(rows: TenantPublic[]): number {
  const byBuilder = new Map<string, number>();
  for (const t of rows) {
    const key = (t.builder_address || t.id).toLowerCase();
    byBuilder.set(key, Math.max(byBuilder.get(key) ?? 0, volumeUsd(t)));
  }
  return [...byBuilder.values()].reduce((s, n) => s + n, 0);
}

function trendScore(t: TenantPublic): number {
  const vol = volumeUsd(t);
  const orders = displayOrders(t);
  const ageH = Math.max(1, (Date.now() - createdMs(t)) / 3_600_000);
  // Fresh apps with any activity rank up; pure volume still wins at scale.
  return vol * 0.001 + orders * 12 + 48 / Math.sqrt(ageH);
}

function sortTenants(
  rows: TenantPublic[],
  sort: SortKey,
  markets: Record<string, CoinMarket> | undefined,
): TenantPublic[] {
  const next = [...rows];
  if (sort === 'new') {
    next.sort((a, b) => createdMs(b) - createdMs(a));
  } else if (sort === 'volume') {
    next.sort((a, b) => volumeUsd(b) - volumeUsd(a) || createdMs(b) - createdMs(a));
  } else if (sort === 'mcap') {
    next.sort((a, b) => mcapUsd(b, markets) - mcapUsd(a, markets) || createdMs(b) - createdMs(a));
  } else {
    next.sort((a, b) => trendScore(b) - trendScore(a) || createdMs(b) - createdMs(a));
  }
  return next;
}

/** Shared directory read + derived stats (Home teaser and Explore both use it). */
export function useCreatorDirectory() {
  const directory = useQuery({
    queryKey: ['tenants', 'directory'],
    queryFn: () => listTenantDirectory(60),
    staleTime: 30_000,
  });
  const all = directory.data ?? [];
  return {
    directory,
    all,
    activeBuilders: all.length,
    totalTokens: all.filter((t) => t.coin?.token).length,
    totalVolume: uniqueBuilderVolume(all),
  };
}

export function ExplorePage() {
  const { authenticated } = useWebAuth();
  const [sort, setSort] = useState<SortKey>('mcap');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const { directory, all, activeBuilders, totalTokens, totalVolume } = useCreatorDirectory();
  // `?creator=<key>` — one creator's apps (from the "by @handle" byline / "More from" strip).
  const [params, setParams] = useSearchParams();
  const creatorKey = (params.get('creator') || '').trim();
  const scoped = useMemo(
    () => (creatorKey ? all.filter((t) => t.creator?.key === creatorKey) : all),
    [all, creatorKey],
  );
  const scopedCreator = creatorKey ? scoped.find((t) => t.creator)?.creator ?? null : null;
  const clearCreator = () => {
    const next = new URLSearchParams(params);
    next.delete('creator');
    setParams(next, { replace: true });
    setVisible(PAGE_SIZE);
  };

  const markets = useCoinMarkets(all.map((t) => t.coin));
  const rows = useMemo(() => sortTenants(scoped, sort, markets.data), [scoped, sort, markets.data]);
  const shown = rows.slice(0, visible);
  const hasMore = rows.length > visible;
  const earnedMap = useCreatorEarnedUsd(all.map((t) => t.coin));
  const statsLoading = directory.isLoading;

  const setSortReset = (next: SortKey) => {
    setSort(next);
    setVisible(PAGE_SIZE);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <section className="relative overflow-hidden rounded-2xl border border-stroke-weak">
        <img
          src={exploreBanner}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-right"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#071210] via-[#071210]/70 to-transparent" />
        <div className="relative z-10 flex min-h-[180px] flex-col justify-center px-5 py-7 sm:min-h-[210px] sm:px-8 lg:px-10">
          <div className="max-w-[22rem] sm:max-w-[28rem]">
            <h1 className="display text-4xl sm:text-5xl">
              Explore <span className="text-hype">creators</span>
            </h1>
            <p className="mt-3 text-sm leading-6 text-fg-muted">
              Every app here runs on Hyperliquid with the creator&apos;s own builder fee. Trade with them, back their
              token, or start your own.
            </p>
            <Link
              to={authenticated ? '/create' : loginHref('/create')}
              className="btn-hype mt-5 w-fit px-5 py-2.5 text-sm"
            >
              <IconRocket size={16} /> Become a creator
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-4 grid gap-3 sm:grid-cols-3">
        <HeroStat
          icon={<IconUsers size={16} />}
          label="Active builders"
          value={statsLoading ? '—' : String(activeBuilders)}
        />
        <HeroStat
          icon={<IconCoin size={16} />}
          label="Total tokens"
          value={statsLoading ? '—' : String(totalTokens)}
        />
        <HeroStat
          icon={<IconChart size={16} />}
          label="Total volume"
          value={statsLoading ? '—' : formatCompactUsd(totalVolume)}
        />
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="chip"
            aria-pressed={sort === s.id}
            onClick={() => setSortReset(s.id)}
          >
            <span aria-hidden>{s.emoji}</span>
            {s.label}
          </button>
        ))}
        {creatorKey ? (
          <button
            type="button"
            onClick={clearCreator}
            className="chip inline-flex items-center gap-1.5 border-brand/50 text-brand"
            title="Show all creators"
          >
            {scopedCreator ? `${creatorLabel(scopedCreator)} · ${scoped.length} apps` : 'One creator'}
            <IconClose size={11} />
          </button>
        ) : null}
        <span className="ml-auto text-[11px] font-bold text-fg-subtle">
          {directory.isLoading ? (
            <span className="skel inline-block h-3 w-20 align-middle" />
          ) : creatorKey ? (
            `${rows.length} apps`
          ) : (
            `${rows.length} creators`
          )}
        </span>
      </div>

      {directory.isError ? (
        <p className="mt-6 text-sm text-error">{(directory.error as Error).message}</p>
      ) : directory.isLoading ? (
        <HomeFeedSkeleton />
      ) : rows.length === 0 ? (
        <div className="card-pop mt-6 flex flex-wrap items-center justify-between gap-4 p-6">
          <div>
            <div className="text-lg font-extrabold">{creatorKey ? 'No live apps for that creator.' : 'No creators yet.'}</div>
            <p className="mt-1 text-sm text-fg-muted">
              {creatorKey ? (
                <button type="button" className="font-bold text-brand hover:underline" onClick={clearCreator}>
                  Show everyone
                </button>
              ) : (
                'Be the first one traders can back.'
              )}
            </p>
          </div>
          <Link to={authenticated ? '/create' : loginHref('/create')} className="btn-primary px-5 py-3 text-sm">
            <IconRocket size={16} /> Launch
          </Link>
        </div>
      ) : (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((t) => (
            <li key={t.id}>
              <CreatorAppCard
                tenant={t}
                market={marketFor(markets.data, t.coin?.token)}
                tokenEarnedUsd={earnedFor(earnedMap.data, t.coin?.token)}
                to={tenantAppHref(t.slug)}
              />
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            className="btn-ghost px-5 py-2.5 text-sm"
            onClick={() => setVisible((n) => n + PAGE_SIZE)}
          >
            Show more · {rows.length - visible} left
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HeroStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{label}</div>
        <div className="mt-0.5 text-lg font-black tabular text-fg">{value}</div>
      </div>
    </div>
  );
}
