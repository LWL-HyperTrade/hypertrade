import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listTenantDirectory } from '../lib/api';
import { formatCompactUsd, formatSignedPct, formatUsdPrice } from '../lib/earnings';
import { tenantAppHref } from '../lib/config';
import { creatorLabel, displayOrders, displayVolumeUsd, type TenantPublic } from '../lib/tenants';
import { marketFor, useCoinMarkets } from '../lib/useCoinMarkets';
import { IconCandles, IconCheck, IconCoin } from './icons';
import { AppHref } from './AppHref';
import { creatorExploreHref } from './CreatorByline';
import { Skel } from './skeleton';

/**
 * One ranked row. A verified creator with 2+ live apps collapses into a single
 * row (their best-scoring app is the face; volume / orders are summed) so the
 * widget ranks *creators*, not the same person three times.
 */
type TopEntry = {
  id: string;
  lead: TenantPublic;
  apps: TenantPublic[];
  volume: number;
  orders: number;
  score: number;
};

function groupByCreator(rows: TenantPublic[]): TopEntry[] {
  const byKey = new Map<string, TenantPublic[]>();
  for (const t of rows) {
    const key = t.creator && t.creator.apps.length > 1 ? `c:${t.creator.key}` : `t:${t.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), t]);
  }
  return [...byKey.entries()].map(([id, apps]) => {
    const sorted = [...apps].sort((a, b) => trendScore(b) - trendScore(a) || createdMs(b) - createdMs(a));
    return {
      id,
      lead: sorted[0],
      apps: sorted,
      volume: apps.reduce((s, t) => s + volumeUsd(t), 0),
      orders: apps.reduce((s, t) => s + displayOrders(t), 0),
      score: apps.reduce((s, t) => s + trendScore(t), 0),
    };
  });
}

const TOP_N_DESKTOP = 7;
const TOP_N_MOBILE = 4;

function volumeUsd(t: TenantPublic): number {
  return displayVolumeUsd(t);
}

function createdMs(t: TenantPublic): number {
  const n = Date.parse(String(t.coin?.launched_at || t.created_at || ''));
  return Number.isFinite(n) ? n : 0;
}

function trendScore(t: TenantPublic): number {
  const vol = volumeUsd(t);
  const orders = displayOrders(t);
  const ageH = Math.max(1, (Date.now() - createdMs(t)) / 3_600_000);
  return vol * 0.001 + orders * 12 + 48 / Math.sqrt(ageH);
}

function isVerified(t: TenantPublic): boolean {
  const s = t.socials;
  return Boolean(s?.twitter || s?.telegram || s?.discord || s?.website);
}

export function TopCreators() {
  const directory = useQuery({
    queryKey: ['tenants', 'directory'],
    queryFn: () => listTenantDirectory(60),
    staleTime: 30_000,
  });

  const top = groupByCreator(directory.data ?? [])
    .sort((a, b) => b.score - a.score || createdMs(b.lead) - createdMs(a.lead))
    .slice(0, TOP_N_DESKTOP);
  const quotes = useCoinMarkets(top.map((e) => e.lead.coin));

  return (
    <section className="relative overflow-hidden rounded-2xl border border-stroke-weak bg-surface">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(90%_100%_at_10%_0%,color-mix(in_srgb,var(--text-brand)_16%,transparent),transparent_70%)]"
        aria-hidden
      />
      <div className="relative flex items-center justify-between gap-2 border-b border-stroke-weak px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-fg-muted">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-md bg-brand-soft text-[10px] leading-none" aria-hidden>
            🔥
          </span>
          Top creators
        </p>
        <Link
          to="/explore"
          className="rounded-full px-2 py-0.5 text-[10px] font-bold text-fg-subtle transition-colors hover:bg-brand-soft hover:text-brand"
        >
          See all
        </Link>
      </div>

      {directory.isLoading ? (
        <div className="grid divide-y divide-stroke-weak px-1.5 py-0.5" aria-busy="true">
          {Array.from({ length: TOP_N_MOBILE }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2 py-2.5">
              <Skel className="h-3 w-3 shrink-0 rounded" />
              <Skel className="h-9 w-9 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1">
                <Skel className="h-3 w-24" />
                <Skel className="mt-1.5 h-2.5 w-14" />
              </div>
              <Skel className="h-3 w-10" />
            </div>
          ))}
        </div>
      ) : top.length === 0 ? (
        <p className="px-3.5 py-4 text-[11px] leading-4 text-fg-subtle">
          No creators yet. Launch to show up here.
        </p>
      ) : (
        <ol className="grid divide-y divide-stroke-weak px-1.5 py-0.5">
          {top.map((e, i) => (
            <li
              key={e.id}
              className={i >= TOP_N_MOBILE ? 'hidden lg:block' : undefined}
            >
              <CreatorRow
                rank={i + 1}
                entry={e}
                market={marketFor(quotes.data, e.lead.coin?.token)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CreatorRow({
  rank,
  entry,
  market,
}: {
  rank: number;
  entry: TopEntry;
  market?: ReturnType<typeof marketFor>;
}) {
  const t = entry.lead;
  const grouped = entry.apps.length > 1 && !!t.creator;
  const ticker = (t.coin?.symbol || '').toUpperCase() || null;
  const hasApp = entry.apps.some((a) => a.status === 'live');
  const hasToken = entry.apps.some((a) => !!a.coin);
  const verified = isVerified(t);
  const change = market?.change24h;
  const up = change != null && change > 0;
  const down = change != null && change < 0;
  const vol = entry.volume;
  const mcap = grouped ? null : market?.mcapUsd;
  const metric =
    ticker && mcap != null && Number.isFinite(mcap) && mcap > 0
      ? formatCompactUsd(mcap)
      : vol > 0
        ? formatCompactUsd(vol)
        : ticker
          ? formatUsdPrice(market?.priceUsd)
          : 'New';
  const metricHint = ticker && mcap != null && mcap > 0 ? 'mcap' : vol > 0 ? 'vol' : ticker ? 'px' : '';

  return (
    <AppHref
      to={grouped && t.creator ? creatorExploreHref(t.creator) : tenantAppHref(t.slug)}
      className="group flex items-center gap-2.5 rounded-xl px-2 py-2.5 transition-colors hover:bg-fill-weaker/80"
    >
      <span
        className={`w-4 shrink-0 text-center text-[11px] font-black tabular ${
          rank === 1 ? 'text-brand' : 'text-fg-subtle'
        }`}
      >
        {rank}
      </span>

      {t.logo_url ? (
        <img
          src={t.logo_url}
          alt=""
          className="h-9 w-9 shrink-0 rounded-xl object-cover"
        />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-[13px] font-black text-brand">
          {(t.app_name || '?').slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[13px] font-extrabold leading-tight text-fg group-hover:text-brand">
            {grouped ? creatorLabel(t.creator) : t.app_name}
          </span>
          {verified ? (
            <span
              className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[#3b82f6] text-white"
              title="Verified socials"
            >
              <IconCheck size={8} strokeWidth={4} />
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] font-semibold">
          {grouped ? (
            <span className="truncate text-fg-subtle">
              {entry.apps.length} apps · {t.app_name}
            </span>
          ) : ticker ? (
            <span className="truncate font-mono text-fg-muted">${ticker}</span>
          ) : (
            <span className="truncate text-fg-subtle">@{t.slug}</span>
          )}
          <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden>
            <span
              title={hasApp ? 'Trading app live' : 'No live app yet'}
              className={hasApp ? 'text-brand' : 'text-fg-subtle/35'}
            >
              <IconCandles size={11} />
            </span>
            <span
              title={hasToken ? 'Creator token launched' : 'No token yet'}
              className={hasToken ? 'text-brand' : 'text-fg-subtle/35'}
            >
              <IconCoin size={11} />
            </span>
          </span>
          {!grouped && ticker && change != null ? (
            <span
              className={`shrink-0 tabular ${
                up ? 'text-market-up' : down ? 'text-market-down' : 'text-fg-subtle'
              }`}
            >
              {formatSignedPct(change)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-[12px] font-extrabold tabular leading-tight text-fg">{metric}</div>
        {metricHint ? (
          <div className="text-[9px] font-bold uppercase tracking-wide text-fg-subtle">{metricHint}</div>
        ) : null}
      </div>
    </AppHref>
  );
}
