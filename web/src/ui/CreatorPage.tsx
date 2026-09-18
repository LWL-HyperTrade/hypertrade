import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchCatalogAssets,
  fetchTenant,
  listTenantDirectory,
  patchTenant,
  uploadTenantLogo,
} from '../lib/api';
import { useWebAuth } from '../lib/auth';
import { useTenantPaths, useTenantSlug } from '../lib/brandedHost';
import {
  formatCompactCount,
  formatCompactUsd,
  formatFeePercent,
  formatSignedPct,
  formatTaxBps,
  formatUsdPrice,
} from '../lib/earnings';
import { displaySymbol } from '../lib/hlMarket';
import { LOGO_ACCEPT, readLogoFile } from '../lib/imageUpload';
import { RollingUsd } from './Rolling';
import {
  displayEarnedUsd,
  displayVolumeUsd,
  filterAssetsForTenant,
  isExternalCoin,
  pickDefaultMarket,
  type AssetRow,
  type TenantHlBuilder,
  type TenantPublic,
} from '../lib/tenants';
import {
  fetchCreatorEarnedUsd,
  fetchCurveActivity,
  fetchCurveTradeFeeBps,
  fetchDexscreenerPaid,
  fetchTokenSparkline,
  formatGraduationPct,
  geckoTokenUrl,
  isNativeQuote,
  robinhoodTokenUrl,
} from '../lib/pons';
import type { Address } from 'viem';
import { quoteLogoSrc } from '../lib/quoteLogos';
import { marketFor, useCoinMarkets } from '../lib/useCoinMarkets';
import { TokenTradeCard } from './TokenTradeCard';
import { MoreFromCreator } from './CreatorByline';
import { BuilderFeeValue } from './BuilderFee';
import { PledgeValue } from './AppPledge';
import { TokenBuybackValue } from './TokenBuyback';
import { CopyCa } from './CreatorAppCard';
import { Sparkline } from './Sparkline';
import { socialItems } from './socials';
import { useSyncTenantTwitch } from './StreamDeskCard';
import { PartnerMarquee } from './PartnerMarquee';
import { CreatorPageSkeleton } from './skeleton';
import {
  IconBolt,
  IconBurn,
  IconBuyback,
  IconChart,
  IconCheck,
  IconExternal,
  IconPencil,
  IconPercent,
  IconShare,
  IconUsers,
  IconWallet,
} from './icons';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';
import bannerTop from '../assets/images/banner-top.webp';
import appBanner from '../assets/images/app-banner.webp';

const MAX_MARKET_CHIPS = 8;

export function CreatorPage() {
  const slug = useTenantSlug();
  const paths = useTenantPaths();
  const navigate = useNavigate();
  const { authenticated, getAccessToken } = useWebAuth();
  const [copied, setCopied] = useState(false);

  const tenantQ = useQuery({
    queryKey: ['tenant', slug, authenticated],
    enabled: !!slug,
    queryFn: async () => {
      const token = authenticated ? await getAccessToken() : null;
      return fetchTenant(slug, token);
    },
  });
  const dirQ = useQuery({
    queryKey: ['tenants', 'directory'],
    queryFn: () => listTenantDirectory(60),
    staleTime: 30_000,
  });
  const catalogQ = useQuery({
    queryKey: ['catalog'],
    queryFn: fetchCatalogAssets,
    staleTime: 60_000,
  });

  const tenant = tenantQ.data;
  const dirHit = dirQ.data?.find((t) => t.slug === slug);
  const merged = tenant
    ? {
        ...tenant,
        attribution: pickAttribution(tenant.attribution, dirHit?.attribution),
        hl_builder: pickHlBuilder(tenant.hl_builder, dirHit?.hl_builder),
      }
    : undefined;
  const markets = useMemo(
    () => (tenant && catalogQ.data ? filterAssetsForTenant(catalogQ.data, tenant.catalog) : []),
    [tenant, catalogQ.data],
  );
  const firstMarket = pickDefaultMarket(markets);
  const tradeTo =
    tenant && firstMarket ? paths.trade(tenant.slug, firstMarket.coin) : null;

  useEffect(() => {
    if (tenant?.status === 'draft') navigate('/create', { replace: true });
  }, [tenant?.status, navigate]);

  useEffect(() => {
    if (!tenant) return;
    const prev = document.title;
    const ticker = (tenant.coin?.symbol || '').toUpperCase();
    document.title = ticker ? `${tenant.app_name} · $${ticker}` : tenant.app_name;
    return () => {
      document.title = prev;
    };
  }, [tenant]);

  const share = () => {
    const url = window.location.href.split('#')[0];
    const go = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.share) {
      void navigator
        .share({ title: tenant?.app_name, url })
        .then(go)
        .catch(() => {
          void navigator.clipboard.writeText(url).then(go);
        });
      return;
    }
    void navigator.clipboard.writeText(url).then(go);
  };

  if (tenantQ.isLoading || !slug) {
    return <CreatorPageSkeleton />;
  }
  if (tenantQ.isError || !tenant) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="display text-4xl">Creator not found</h1>
        <p className="mt-2 text-sm text-fg-muted">This page is not live.</p>
        <Link to="/explore" className="mt-6 inline-block text-sm font-bold text-brand">
          Discover creators →
        </Link>
      </div>
    );
  }

  const isOwner = authenticated && !!(merged ?? tenant).privy_user_id;

  return (
    <CreatorBody
      tenant={merged ?? tenant}
      markets={markets}
      tradeTo={tradeTo}
      onShare={share}
      copied={copied}
      isOwner={isOwner}
      getAccessToken={getAccessToken}
    />
  );
}

function pickAttribution(
  primary?: TenantPublic['attribution'],
  fallback?: TenantPublic['attribution'],
): NonNullable<TenantPublic['attribution']> {
  const empty = { orders: 0, est_builder_fee_usd: 0, settled_builder_fee_usd: 0, filled_notional_usd: 0 };
  const a = primary ?? empty;
  const b = fallback ?? empty;
  const aLive = (a.orders ?? 0) > 0 || (a.filled_notional_usd ?? 0) > 0;
  return aLive ? a : b;
}

function pickHlBuilder(
  primary?: TenantHlBuilder | null,
  fallback?: TenantHlBuilder | null,
): TenantHlBuilder | null | undefined {
  const a = Number(primary?.filled_notional_usd ?? 0) || 0;
  const b = Number(fallback?.filled_notional_usd ?? 0) || 0;
  if (a >= b) return primary;
  return fallback;
}

/* ------------------------------------------------------------------ */

function CreatorBody({
  tenant,
  markets,
  tradeTo,
  onShare,
  copied,
  isOwner,
  getAccessToken,
}: {
  tenant: TenantPublic;
  markets: AssetRow[];
  tradeTo: string | null;
  onShare: () => void;
  copied: boolean;
  isOwner: boolean;
  getAccessToken: () => Promise<string | null>;
}) {
  useSyncTenantTwitch(tenant, isOwner);
  const { hash } = useLocation();
  const coin = tenant.coin;
  const quotes = useCoinMarkets([coin]);
  const market = marketFor(quotes.data, coin?.token);
  const ticker = (coin?.symbol || '').toUpperCase();
  const vol = displayVolumeUsd(tenant);
  const earned = displayEarnedUsd(tenant);
  const socials = socialItems(tenant);
  const joined = formatJoined(tenant.created_at);
  const about = tenant.description.trim();
  const marketCount = markets.length || tenant.catalog.length;

  // Deep links like /#token from the header when arriving from /terms.
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (!id) return;
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return () => window.clearTimeout(t);
  }, [hash, tenant.id]);

  return (
    <div className="mx-auto max-w-6xl">
      <Hero
        tenant={tenant}
        ticker={ticker}
        socials={socials}
        joined={joined}
        about={about}
        marketCount={marketCount}
        tradeTo={tradeTo}
        onShare={onShare}
        copied={copied}
        isOwner={isOwner}
        getAccessToken={getAccessToken}
      />
      <PartnerMarquee />

      <AppSection
        tenant={tenant}
        markets={markets}
        marketCount={marketCount}
        tradeTo={tradeTo}
        earned={earned}
        vol={vol}
        ticker={ticker}
      />

      {coin ? (
        <TokenSection tenant={tenant} market={market} ticker={ticker} about={about} />
      ) : (
        <TokenComingSoon tenant={tenant} about={about} />
      )}

      <MoreFromCreator tenant={tenant} />
    </div>
  );
}

/* ------------------------------ Hero ------------------------------ */

function Hero({
  tenant,
  ticker,
  socials,
  joined,
  about,
  marketCount,
  tradeTo,
  onShare,
  copied,
  isOwner,
  getAccessToken,
}: {
  tenant: TenantPublic;
  ticker: string;
  socials: ReturnType<typeof socialItems>;
  joined: string;
  about: string;
  marketCount: number;
  tradeTo: string | null;
  onShare: () => void;
  copied: boolean;
  isOwner: boolean;
  getAccessToken: () => Promise<string | null>;
}) {
  const style = { '--creator-hero-bg': `url(${bannerTop})` } as CSSProperties;
  return (
    <section id="home" className="creator-section creator-hero" style={style}>
      <div className="relative mx-auto flex min-h-[280px] max-w-6xl flex-col justify-between px-4 pb-5 pt-14 sm:min-h-[300px] sm:px-6 sm:pb-6 sm:pt-16 lg:min-h-[320px] lg:px-8 lg:pt-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
          <CreatorAvatar
            logoUrl={tenant.logo_url}
            fallback={tenant.app_name.slice(0, 1).toUpperCase()}
            slug={tenant.slug}
            isOwner={isOwner}
            getAccessToken={getAccessToken}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="display text-4xl sm:text-5xl lg:text-6xl">{tenant.app_name}</h1>
                {ticker ? (
                  <span className="font-mono text-lg font-black text-brand sm:text-xl">${ticker}</span>
                ) : null}
                {socials.length ? (
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#3b82f6] text-white"
                    title="Verified socials"
                  >
                    <IconCheck size={10} strokeWidth={4} />
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-semibold text-white/65">
                <span>@{tenant.slug}</span>
                {joined ? (
                  <>
                    <Dot />
                    <span>{joined}</span>
                  </>
                ) : null}
                {marketCount ? (
                  <>
                    <Dot />
                    <span>{marketCount} markets</span>
                  </>
                ) : null}
              </div>
              {about ? (
                <p className="mt-3 max-w-2xl text-[15px] leading-6 text-white/80">{about}</p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                {tradeTo ? (
                  <Link to={tradeTo} className="btn-primary px-5 py-2.5 text-sm">
                    Launch App <IconExternal size={15} />
                  </Link>
                ) : (
                  <button type="button" className="btn-primary px-5 py-2.5 text-sm" disabled>
                    Launch App <IconExternal size={15} />
                  </button>
                )}
                {ticker ? (
                  <a href="#token" className="btn-hype px-5 py-2.5 text-sm">
                    Buy ${ticker}
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-1.5 sm:mt-8">
              {socials.map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noreferrer"
                  title={s.title}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-black/25 text-white/80 backdrop-blur hover:bg-black/40 hover:text-white"
                >
                  <s.Icon size={16} />
                </a>
              ))}
              <button
                type="button"
                onClick={onShare}
                aria-label={copied ? 'Link copied' : 'Share this page'}
                title={copied ? 'Copied' : 'Share'}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-white/15 bg-black/25 px-3 text-[12px] font-bold text-white/80 backdrop-blur hover:bg-black/40 hover:text-white"
              >
                {copied ? <IconCheck size={16} /> : <IconShare size={16} />}
                {copied ? 'Copied' : 'Share'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* --------------------------- App section -------------------------- */

function AppSection({
  tenant,
  markets,
  marketCount,
  tradeTo,
  earned,
  vol,
  ticker,
}: {
  tenant: TenantPublic;
  markets: AssetRow[];
  marketCount: number;
  tradeTo: string | null;
  earned: number;
  vol: number;
  ticker: string;
}) {
  const style = { '--creator-app-bg': `url(${appBanner})` } as CSSProperties;
  const chips = useMemo(() => marketChips(markets), [markets]);
  const extra = Math.max(0, marketCount - chips.length);
  const buyback = tenant.buyback_pct ?? 0;
  const feeLabel = formatFeePercent(tenant.builder_fee_tenths);
  const pitch =
    buyback > 0 && ticker
      ? `A ${feeLabel} builder fee on every fill — ${buyback}% of it buys back $${ticker}.`
      : `Trade diverse markets with low transparent fees.`;

  return (
    <section id="app" className="creator-section mt-6 sm:mt-8">
      <SectionHead
        eyebrow="The App"
        title={/markets$/i.test(tenant.app_name) ? tenant.app_name : `${tenant.app_name} Markets`}
        sub="Perps and spot on Hyperliquid. One login, one balance, your picks."
      />

      <div className="creator-app" style={style}>
        <div className="grid md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="flex min-h-[320px] flex-col justify-between p-6 sm:p-8 lg:min-h-[400px] lg:p-10">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-success">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-success" />
                Live on Hyperliquid
              </span>
              <h3 className="display mt-4 text-3xl text-white sm:text-4xl lg:text-[2.75rem]">
                Trade {marketCount ? `${marketCount} markets` : 'the markets'}.
                <br />
                Follow {tenant.app_name}'s journey.
              </h3>
              <p className="mt-3 max-w-md text-[14px] leading-6 text-white/75">{pitch}</p>

              {chips.length ? (
                <div className="mt-5 flex flex-wrap items-center gap-1.5">
                  {chips.map((c) => (
                    <span
                      key={c.key}
                      className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-black/35 py-1 pl-1 pr-2.5 text-[11px] font-extrabold text-white/90 backdrop-blur"
                    >
                      {c.logo ? (
                        <img src={c.logo} alt="" className="h-4 w-4 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[8px] font-black">
                          {c.label.slice(0, 1)}
                        </span>
                      )}
                      {c.label}
                    </span>
                  ))}
                  {extra > 0 ? (
                    <span className="rounded-full border border-white/12 bg-black/35 px-2.5 py-1 text-[11px] font-extrabold text-white/70">
                      +{extra} more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              {tradeTo ? (
                <Link to={tradeTo} className="btn-primary px-5 py-2.5 text-sm">
                  Launch App <IconExternal size={15} />
                </Link>
              ) : (
                <button type="button" className="btn-primary px-5 py-2.5 text-sm" disabled>
                  Launch App <IconExternal size={15} />
                </button>
              )}
              <span className="text-[12px] font-semibold text-white/55">
                Email sign-in · self-custody · deep liquidity
              </span>
            </div>
          </div>
          <div aria-hidden className="hidden md:block" />
        </div>
      </div>

      <div className="stat-rail mt-6 sm:mt-8">
        <div>
          <StatLabel icon={<IconBolt size={12} />}>Earned</StatLabel>
          <div className="mt-1 text-xl font-black tabular sm:text-2xl">
            <RollingUsd value={earned} format={usdTiny} className="text-hype" />
          </div>
          <div className="mt-0.5 text-[10px] font-bold text-fg-subtle">builder fees, lifetime</div>
        </div>
        <Stat icon={<IconChart size={12} />} label="Volume" value={formatCompactUsd(vol)} />
        <Stat
          icon={<IconPercent size={12} />}
          label="Builder Fee"
          value={<BuilderFeeValue tenths={tenant.builder_fee_tenths} history={tenant.builder_fee_history} />}
        />
        <Stat
          icon={<IconBuyback size={12} />}
          label="Buybacks"
          value={
            <PledgeValue label="Buybacks" pct={tenant.buyback_pct ?? 0} history={tenant.buyback_history} hideLabel />
          }
        />
        <Stat
          icon={<IconBurn size={12} />}
          label="Burn"
          value={<PledgeValue label="Burn" pct={tenant.burn_pct ?? 0} history={tenant.burn_history} hideLabel />}
        />
      </div>

      <ol className="mt-6 grid gap-4 sm:mt-8 sm:grid-cols-3 sm:gap-5">
        <Step n={1} title="Sign in" body="Email, Google, or a wallet. A self-custody wallet is created for you." />
        <Step n={2} title="Fund" body="Deposit USDC on Arbitrum. It lands as one unified trade balance." />
        <Step
          n={3}
          title="Trade"
          body={`Perps and spot in ${tenant.app_name}'s terminal. Every fill supports the creator.`}
        />
      </ol>
    </section>
  );
}

/* -------------------------- Token section ------------------------- */

function TokenSection({
  tenant,
  market,
  ticker,
  about,
}: {
  tenant: TenantPublic;
  market: ReturnType<typeof marketFor>;
  ticker: string;
  about: string;
}) {
  const coin = tenant.coin!;
  const external = isExternalCoin(coin);
  const tokenEarnedQ = useQuery({
    queryKey: ['pons-earned-usd', coin.token, coin.fee_recipient],
    enabled: !external,
    queryFn: () => fetchCreatorEarnedUsd(coin),
    staleTime: 30_000,
    refetchInterval: 45_000,
  });
  const tradeFeeQ = useQuery({
    queryKey: ['pons-trade-fee', coin.curve],
    enabled: !external && !!coin.curve,
    queryFn: () => fetchCurveTradeFeeBps(coin.curve as Address),
    staleTime: 60_000,
  });
  const onCurve = !external && market?.source !== 'dex' && !!coin.curve;
  const sparkQ = useQuery({
    queryKey: ['token-spark', coin.token, market?.source ?? 'unknown'],
    // On the curve the sparkline comes from `activityQ` (same logs, one fetch).
    enabled: !onCurve,
    queryFn: () => fetchTokenSparkline(coin, external ? 'dex' : market?.source),
    staleTime: 60_000,
    refetchInterval: 90_000,
  });
  // Gecko / Dexscreener do not index a curve token — derive from CurveBuy / CurveSell logs.
  // Key is token+curve only: the ETH price is applied at render, otherwise every
  // markets refetch would change the key and blank the stats for a beat.
  const activityQ = useQuery({
    queryKey: ['pons-activity', coin.token, coin.curve],
    enabled: onCurve,
    queryFn: () => fetchCurveActivity(coin, null),
    staleTime: 15_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const dexPaidQ = useQuery({
    queryKey: ['dex-paid', coin.token],
    queryFn: () => fetchDexscreenerPaid(coin.token),
    staleTime: 10 * 60_000,
    refetchInterval: 10 * 60_000,
    placeholderData: keepPreviousData,
  });
  const activity = onCurve ? (activityQ.data ?? null) : null;
  const tokenEarned = tokenEarnedQ.data ?? 0;
  const tradeFeeLabel = tradeFeeQ.data != null ? formatTaxBps(tradeFeeQ.data) : '…';
  const spark = onCurve ? (activity?.spark ?? []) : (sparkQ.data ?? []);
  const activityVolumeUsd =
    activity && market?.quoteUsd != null ? activity.volumeQuote24h * market.quoteUsd : null;
  const volumeUsd = market?.volumeUsd ?? activityVolumeUsd ?? null;
  const dexPaid = dexPaidQ.data ?? null;
  const change = market?.change24h ?? null;
  const up =
    change != null
      ? change >= 0
      : spark.length >= 2
        ? spark[spark.length - 1] >= spark[0]
        : true;
  const graduated = external || !!market?.graduation?.graduated || market?.source === 'dex';
  const viewUrl = market?.geckoUrl ?? geckoTokenUrl(coin.token);
  const venue = coin.venue || 'pools.xyz';
  const venueTradeLabel = venue.replace(/^.*·\s*/, '').trim() || venue;

  return (
    <section id="token" className="creator-section mt-8 sm:mt-10">
      <SectionHead
        eyebrow="The Token"
        title={`$${ticker}`}
        sub={
          external
            ? `Creator coin on Robinhood Chain. Trading on ${venue}.`
            : graduated
              ? 'Creator coin on Robinhood Chain. Trading on Uniswap v4.'
              : 'Creator coin on Robinhood Chain. Early — still on the bonding curve.'
        }
      />

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-4">
        {/*
          Mobile: `contents` so token → trade → stats can reorder with flex order.
          Desktop: one left column stacks token + stats tightly (no row-span stretch).
        */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-3">
          <div className="creator-token order-1 min-w-0 p-5 sm:p-7 lg:order-none">
            <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
              <div className="flex gap-4">
                <div className="relative shrink-0">
                  {tenant.logo_url ? (
                    <img
                      src={tenant.logo_url}
                      alt=""
                      className="h-16 w-16 rounded-full object-cover ring-2 ring-brand/70 ring-offset-2 ring-offset-[#0d1a17] sm:h-20 sm:w-20"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand text-2xl font-black text-black ring-2 ring-brand/70 ring-offset-2 ring-offset-[#0d1a17] sm:h-20 sm:w-20">
                      {ticker.slice(0, 1)}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xl font-black tracking-tight sm:text-2xl">{tenant.app_name}</span>
                    <span
                      className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-full bg-[#3b82f6] text-white"
                      title="Launched by this creator"
                    >
                      <IconCheck size={9} strokeWidth={4} />
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-fg-muted">
                    <span className="font-mono text-fg">${ticker}</span>
                    <Dot />
                    <span className="inline-flex items-center gap-1.5">
                      <img src={robinhoodIcon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
                      Robinhood Chain
                      <a
                        href={market?.explorerUrl ?? robinhoodTokenUrl(coin.token)}
                        target="_blank"
                        rel="noreferrer"
                        title="Explorer"
                        className="inline-flex text-fg-subtle hover:text-fg"
                      >
                        <IconExternal size={12} />
                      </a>
                    </span>
                  </div>
                  <p className="mt-2 max-w-sm text-[13px] leading-5 text-fg-muted">
                    {about || `${tenant.app_name}'s community token. Trade it here, hold it anywhere.`}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <a
                      href={viewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-primary btn-sm px-3.5 py-1.5 text-xs"
                    >
                      View Token <IconExternal size={12} />
                    </a>
                    <CopyCa
                      value={coin.token}
                      className="inline-flex items-center gap-1 rounded-lg border border-stroke-weak bg-fill-weaker px-2 py-1 font-mono text-[11px] font-bold text-fg-muted hover:text-fg"
                    />
                  </div>
                </div>
              </div>

              <div className="relative min-w-0">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="text-3xl font-black tabular tracking-tight sm:text-4xl">
                      {formatUsdPrice(market?.priceUsd)}
                    </div>
                    <div
                      className={`mt-1 text-lg font-black tabular ${
                        change == null ? 'text-fg-subtle' : up ? 'text-market-up' : 'text-market-down'
                      }`}
                    >
                      {change != null ? formatSignedPct(change) : graduated ? '—' : 'on curve'}
                      {change != null ? <span className="ml-1.5 text-[11px] font-bold text-fg-subtle">24h</span> : null}
                    </div>
                  </div>
                  {market?.graduation && !market.graduation.graduated ? (
                    <div className="text-right">
                      <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
                        To graduation
                      </div>
                      <div className="text-[15px] font-black tabular text-brand">
                        {formatGraduationPct(market.graduation.pct)}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="mt-3 h-20 w-full">
                  {spark.length >= 2 ? (
                    <Sparkline points={spark} up={up} className="h-full w-full" />
                  ) : (
                    <div className="flex h-full flex-col items-start justify-end gap-1">
                      <div className="h-px w-full bg-gradient-to-r from-brand/40 via-brand/15 to-transparent" />
                      {onCurve ? (
                        <span className="text-[10px] font-semibold text-fg-subtle">
                          {activityQ.isPending
                            ? 'Reading curve trades…'
                            : (activity?.trades ?? 0) < 2
                              ? 'Price per trade appears here after the first couple of trades.'
                              : 'No price history yet.'}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-stroke-weak pt-4">
                  <Mini label="Market Cap" value={formatMcap(market?.mcapUsd)} />
                  <Mini
                    label="24h Volume"
                    value={
                      volumeUsd != null
                        ? formatCompactUsd(volumeUsd)
                        : activity && activity.volumeQuote24h > 0 && isNativeQuote(coin.pair_token)
                          ? `${activity.volumeQuote24h.toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`
                          : '—'
                    }
                  />
                  <a
                    href={dexPaid?.url ?? `https://dexscreener.com/robinhood/${coin.token}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group block"
                    title={
                      dexPaid?.paid
                        ? `Dexscreener Enhanced Token Info is paid${dexPaid.approved.length > 1 ? ` (${dexPaid.approved.join(', ')})` : ''}`
                        : dexPaid?.pending
                          ? 'Dexscreener profile order is processing'
                          : onCurve
                            ? 'Dexscreener lists the token once it graduates to Uniswap v4'
                            : 'No paid Dexscreener profile yet'
                    }
                  >
                    <Mini
                      label="Dexscreener"
                      value={
                        dexPaidQ.isPending && !dexPaid
                          ? '…'
                          : dexPaid?.paid
                            ? 'Paid'
                            : dexPaid?.pending
                              ? 'Pending'
                              : 'Not paid'
                      }
                      icon={
                        dexPaid?.paid ? (
                          <IconCheck size={10} className="text-market-up" />
                        ) : (
                          <IconExternal size={10} className="opacity-60 group-hover:opacity-100" />
                        )
                      }
                    />
                  </a>
                </div>
              </div>
            </div>
          </div>

          {external ? (
            <div className="stat-rail order-3 min-w-0 lg:order-none">
              <Stat icon={<IconChart size={12} />} label="Market cap" value={formatMcap(market?.mcapUsd)} />
              <Stat
                icon={<IconChart size={12} />}
                label="24h volume"
                value={market?.volumeUsd != null ? formatCompactUsd(market.volumeUsd) : '—'}
              />
              <Stat
                icon={<IconUsers size={12} />}
                label="Holders"
                value={market?.holders != null ? formatCompactCount(market.holders) : '—'}
              />
              <Stat
                icon={<IconChart size={12} />}
                label="24h trades"
                value={market?.trades != null ? formatCompactCount(market.trades) : '—'}
              />
              <Stat
                icon={<IconExternal size={12} />}
                label="Venue"
                value={<span className="text-[15px] sm:text-lg">{venueTradeLabel}</span>}
              />
            </div>
          ) : (
            <div className="stat-rail order-3 min-w-0 lg:order-none">
              <div>
                <StatLabel icon={<IconBolt size={12} />}>Earned</StatLabel>
                <div className="mt-1 text-xl font-black tabular sm:text-2xl">
                  <RollingUsd value={tokenEarned} format={usdTiny} className="text-hype" />
                </div>
                <div className="mt-0.5 text-[10px] font-bold text-fg-subtle">token fees, lifetime</div>
              </div>
              <Stat icon={<IconChart size={12} />} label="Market cap" value={formatMcap(market?.mcapUsd)} />
              <Stat icon={<IconPercent size={12} />} label="Trade fee" value={tradeFeeLabel} />
              <Stat
                icon={<IconBuyback size={12} />}
                label="Buybacks"
                value={<TokenBuybackValue enabled={!!coin.buyback_enabled} />}
              />
              <Stat icon={<IconPercent size={12} />} label="Creator Tax" value={formatTaxBps(coin.creator_tax_bps)} />
            </div>
          )}
        </div>

        <aside className="order-2 min-w-0 lg:sticky lg:top-20">
          {external ? (
            <ExternalTradeCard tenant={tenant} ticker={ticker} market={market} venue={venueTradeLabel} />
          ) : (
            <>
              <TokenTradeCard tenant={tenant} market={market} embedded />
              <p className="mt-2 px-1 text-center text-[11px] font-semibold text-fg-subtle">
                <IconWallet size={11} className="mr-1 inline-block align-[-1px]" />
                Buys use your trade wallet on Robinhood Chain.
              </p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

/** Non-Pons token (showcase). No curve ticket — send the trader to the venue. */
function ExternalTradeCard({
  tenant,
  ticker,
  market,
  venue,
}: {
  tenant: TenantPublic;
  ticker: string;
  market: ReturnType<typeof marketFor>;
  venue: string;
}) {
  const coin = tenant.coin!;
  const tradeUrl = coin.trade_url || market?.dexUrl || geckoTokenUrl(coin.token);
  const change = market?.change24h ?? null;
  return (
    <div className="card-money p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-brand">Trade ${ticker}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-black tabular tracking-tight">{formatUsdPrice(market?.priceUsd)}</span>
            {change != null ? (
              <span
                className={`text-[12px] font-black tabular ${
                  change >= 0 ? 'text-market-up' : 'text-market-down'
                }`}
              >
                {formatSignedPct(change)}
              </span>
            ) : null}
          </div>
        </div>
        <img src={robinhoodIcon} alt="" className="h-8 w-8 shrink-0 rounded-full" />
      </div>

      <p className="mt-3 text-[12px] leading-5 text-fg-muted">
        ${ticker} trades on {venue} on Robinhood Chain. Buy and sell there with any Robinhood Chain wallet.
      </p>

      <a
        href={tradeUrl}
        target="_blank"
        rel="noreferrer"
        className="btn-hype mt-4 w-full py-3 text-sm"
      >
        Trade on {venue} <IconExternal size={14} />
      </a>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <a
          href={market?.dexUrl ?? `https://dexscreener.com/robinhood/${coin.token}`}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost btn-sm py-2 text-[11px]"
        >
          Dexscreener <IconExternal size={11} />
        </a>
        <a
          href={market?.geckoUrl ?? geckoTokenUrl(coin.token)}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost btn-sm py-2 text-[11px]"
        >
          GeckoTerminal <IconExternal size={11} />
        </a>
      </div>
    </div>
  );
}

/** Same layout as TokenSection — placeholders until the creator launches a coin. */
function TokenComingSoon({ tenant, about }: { tenant: TenantPublic; about: string }) {
  const initial = tenant.app_name.slice(0, 1).toUpperCase();
  return (
    <section id="token" className="creator-section mt-8 sm:mt-10">
      <SectionHead
        eyebrow="The Token"
        title="Coming soon"
        sub="Creator coin on Robinhood Chain. Launch is next — same app identity."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-stretch lg:gap-x-4">
        <div className="creator-token min-w-0 p-5 sm:p-7">
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
            <div className="flex gap-4">
              <div className="relative shrink-0">
                {tenant.logo_url ? (
                  <img
                    src={tenant.logo_url}
                    alt=""
                    className="h-16 w-16 rounded-full object-cover opacity-80 ring-2 ring-brand/40 ring-offset-2 ring-offset-[#0d1a17] sm:h-20 sm:w-20"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand/80 text-2xl font-black text-black ring-2 ring-brand/40 ring-offset-2 ring-offset-[#0d1a17] sm:h-20 sm:w-20">
                    {initial}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xl font-black tracking-tight sm:text-2xl">{tenant.app_name}</span>
                  <span className="rounded-full border border-brand/35 bg-brand/10 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em] text-brand">
                    Soon
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-fg-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <img src={robinhoodIcon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
                    Robinhood Chain
                  </span>
                </div>
                <p className="mt-2 max-w-sm text-[13px] leading-5 text-fg-muted">
                  {about ||
                    `${tenant.app_name}'s community token isn't live yet. Trade the app markets now — the coin lands here when they launch.`}
                </p>
                <div className="mt-4">
                  <span className="inline-flex items-center rounded-lg border border-stroke-weak bg-fill-weaker px-3.5 py-1.5 text-xs font-bold text-fg-subtle">
                    Token launch pending
                  </span>
                </div>
              </div>
            </div>

            <div className="relative min-w-0">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-3xl leading-none sm:text-4xl" aria-hidden>
                    👀
                  </div>
                  <div className="mt-1 text-lg font-black tabular text-fg-subtle">Coming soon</div>
                </div>
              </div>
              <div className="mt-3 flex h-20 w-full items-end">
                <div className="h-px w-full bg-gradient-to-r from-brand/35 via-brand/12 to-transparent" />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 border-t border-stroke-weak pt-4">
                <Mini label="Market Cap" value="👀" />
                <Mini label="24h Volume" value="👀" />
                <Mini label="Dexscreener" value="👀" icon={<IconExternal size={10} />} />
              </div>
            </div>
          </div>
        </div>

        <aside className="min-w-0 lg:h-full">
          <div className="card flex h-full min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center lg:min-h-0">
            {tenant.logo_url ? (
              <img
                src={tenant.logo_url}
                alt=""
                className="h-14 w-14 rounded-2xl object-cover opacity-70 ring-1 ring-stroke-weak"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/70 text-xl font-black text-black">
                {initial}
              </div>
            )}
            <div>
              <div className="text-[15px] font-extrabold tracking-tight">Token trade desk</div>
              <p className="mt-1 max-w-[16rem] text-[12px] leading-5 text-fg-muted">
                Buy and sell will open here when {tenant.app_name} launches their coin.
              </p>
            </div>
            <span className="rounded-full border border-stroke-weak bg-fill-weaker px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] text-fg-subtle">
              Coming soon
            </span>
          </div>
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------ Bits ------------------------------ */

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="display mt-1 text-2xl sm:text-3xl">{title}</h2>
      </div>
      {sub ? <p className="max-w-md text-[13px] font-semibold text-fg-muted">{sub}</p> : null}
    </div>
  );
}

function StatLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
      <span className="text-brand">{icon}</span>
      {children}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div>
      <StatLabel icon={icon}>{label}</StatLabel>
      <div className="mt-1 text-xl font-black tabular sm:text-2xl">{value}</div>
    </div>
  );
}

function Mini({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-fg-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 truncate text-[15px] font-black tabular text-fg sm:text-base">{value}</div>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="card flex gap-3 px-4 py-3.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[12px] font-black text-brand">
        {n}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-extrabold">{title}</div>
        <p className="mt-0.5 text-[12px] leading-5 text-fg-muted">{body}</p>
      </div>
    </li>
  );
}

function Dot() {
  return (
    <span className="text-white/30" aria-hidden>
      ·
    </span>
  );
}

function marketChips(markets: AssetRow[]): { key: string; label: string; logo: string | null }[] {
  const seen = new Set<string>();
  const out: { key: string; label: string; logo: string | null }[] = [];
  const prefer = ['BTC', 'ETH', 'SOL', 'HYPE'];
  const sorted = [...markets].sort((a, b) => {
    const la = displaySymbol(a.coin, a.symbol).toUpperCase();
    const lb = displaySymbol(b.coin, b.symbol).toUpperCase();
    const ia = prefer.indexOf(la);
    const ib = prefer.indexOf(lb);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return 0;
  });
  for (const m of sorted) {
    const label = displaySymbol(m.coin, m.symbol).toUpperCase();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push({ key: m.coin, label, logo: quoteLogoSrc(label) ?? null });
    if (out.length >= MAX_MARKET_CHIPS) break;
  }
  return out;
}

function CreatorAvatar({
  logoUrl,
  fallback,
  slug,
  isOwner,
  getAccessToken,
}: {
  logoUrl: string;
  fallback: string;
  slug: string;
  isOwner: boolean;
  getAccessToken: () => Promise<string | null>;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview || logoUrl;

  useEffect(() => {
    setPreview(null);
  }, [logoUrl]);

  const pick = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const b64 = await readLogoFile(file);
      const logo_url = await uploadTenantLogo(b64, token);
      await patchTenant(slug, { logo_url }, token);
      setPreview(logo_url);
      await qc.invalidateQueries({ queryKey: ['tenant', slug] });
      await qc.invalidateQueries({ queryKey: ['tenant-brand', slug] });
      await qc.invalidateQueries({ queryKey: ['tenants', 'mine'] });
      await qc.invalidateQueries({ queryKey: ['tenants', 'directory'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const ring = 'ring-4 ring-sunken/80';
  return (
    <div className="relative h-24 w-24 shrink-0 self-start sm:h-28 sm:w-28">
      {shown ? (
        <img
          src={shown}
          alt=""
          className={`h-full w-full rounded-3xl object-cover ${ring} ${busy ? 'opacity-60' : ''}`}
        />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center rounded-3xl bg-brand text-4xl font-black text-black ${ring} ${busy ? 'opacity-60' : ''}`}
        >
          {fallback}
        </div>
      )}
      {isOwner ? (
        <>
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            className="hidden"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            aria-label={busy ? 'Uploading avatar' : 'Change avatar'}
            title={error ?? (busy ? 'Uploading…' : 'PNG, JPG, or WebP · max 2 MB')}
            className="absolute bottom-1 right-1 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-black/80 text-white shadow-md hover:bg-black disabled:opacity-60"
          >
            <IconPencil size={13} strokeWidth={2.5} />
          </button>
          {error ? (
            <p className="absolute left-0 top-full z-20 mt-1.5 max-w-[16rem] rounded-lg bg-[#2a1216] px-2.5 py-1.5 text-[11px] font-semibold leading-4 text-error shadow-lg">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function usdTiny(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs < 0.1) return '$0';
  if (abs < 1000) return `$${abs.toFixed(2)}`;
  return formatCompactUsd(v);
}

function formatJoined(iso?: string): string {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  return `Since ${new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
}

function formatMcap(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n < 1000 ? formatUsdPrice(n) : formatCompactUsd(n);
}
