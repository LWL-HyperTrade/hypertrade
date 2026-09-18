import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { loginHref, useWebAuth } from '../lib/auth';
import { TENANT_BASE_DOMAIN } from '../lib/config';
import { formatCompactUsd } from '../lib/earnings';
import { PartnerMarquee } from './PartnerMarquee';
import { useCreatorDirectory } from './ExplorePage';
import {
  IconBuyback,
  IconChart,
  IconCoin,
  IconCommodity,
  IconGlobe,
  IconLock,
  IconPercent,
  IconRocket,
  IconSpot,
  IconStock,
  IconTwitch,
  IconUsers,
  IconWallet,
} from './icons';
import homeBanner from '../assets/images/home-banner.png';

/** Builder fee options — tenths of a bp (100 = 10 bps = 0.1%). Shown as %. */
const FEE_OPTIONS: { tenths: number; label: string }[] = [
  { tenths: 25, label: '0.025%' },
  { tenths: 50, label: '0.05%' },
  { tenths: 100, label: '0.1%' },
];
const VOLUME_OPTIONS: { usd: number; label: string }[] = [
  { usd: 100_000_000, label: '$100M' },
  { usd: 1_000_000_000, label: '$1B' },
  { usd: 10_000_000_000, label: '$10B' },
];

function feeTake(tenths: number, volumeUsd: number): number {
  return (tenths / 100_000) * volumeUsd;
}

/** Full dollar amount for the earnings hook ($1,000,000 not $1M). */
function formatEarnUsd(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.5) return '$0';
  const abs = Math.round(Math.abs(n));
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString('en-US')}`;
}

export function HomePage() {
  const { authenticated } = useWebAuth();
  const launchTo = authenticated ? '/create' : loginHref('/create');
  const { directory, activeBuilders, totalTokens, totalVolume } = useCreatorDirectory();
  const statsLoading = directory.isLoading;

  return (
    <div className="mx-auto max-w-5xl">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-stroke-weak">
        <img src={homeBanner} alt="" className="absolute inset-0 h-full w-full object-cover object-right" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#071210] via-[#071210]/85 to-[#071210]/20" />
        <div className="relative z-10 flex min-h-[300px] flex-col justify-center px-5 py-9 sm:min-h-[340px] sm:px-8 lg:min-h-[380px] lg:px-10">
          <div className="max-w-[24rem] sm:max-w-[30rem]">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-brand">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-brand" />
              Built on Hyperliquid
            </span>
            <h1 className="display mt-4 text-4xl sm:text-5xl lg:text-[3.4rem]">
              Your brand.
              <br />
              Hyperliquid&apos;s liquidity.
              <br />
              <span className="text-hype">100% of the fee.</span>
            </h1>
            <p className="mt-4 max-w-[26rem] text-sm leading-6 text-fg-muted">
              Launch a branded trading app in minutes, set your own builder fee, go live on your handle, and keep
              every cent of it. Optional creator coin with buybacks funded by your fees.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <Link to={launchTo} className="btn-hype px-5 py-3 text-sm">
                <IconRocket size={16} /> Launch your app
              </Link>
              <Link to="/explore" className="btn-ghost px-5 py-3 text-sm">
                Explore creators
              </Link>
            </div>
            <p className="mt-4 text-[11px] font-semibold text-fg-subtle">
              No code · self-custody · live on {'{you}'}.{TENANT_BASE_DOMAIN} or your own domain
            </p>
          </div>
        </div>
      </section>

      {/* Live stats */}
      <section className="mt-4 grid gap-3 sm:grid-cols-3">
        <HeroStat icon={<IconUsers size={16} />} label="Live creators" value={statsLoading ? '—' : String(activeBuilders)} />
        <HeroStat icon={<IconCoin size={16} />} label="Creator coins" value={statsLoading ? '—' : String(totalTokens)} />
        <HeroStat
          icon={<IconChart size={16} />}
          label="Volume through creator apps"
          value={statsLoading ? '—' : formatCompactUsd(totalVolume)}
        />
      </section>

      <div className="overflow-x-clip">
        <PartnerMarquee />
      </div>

      {/* How it works */}
      <section className="mt-10 sm:mt-12">
        <SectionHead
          eyebrow="How it works"
          title="Three chapters, one sitting."
          sub="Identity once. Trading app first, your builder code when you're ready, token last."
        />
        <ol className="mt-6 grid gap-3 sm:grid-cols-3">
          <Step n={1} title="Create your app">
            Name, logo, verified socials, the markets you want, and the builder fee you charge (0–10 bps). Publish to{' '}
            <span className="font-bold text-fg">{'{you}'}.{TENANT_BASE_DOMAIN}</span>.
          </Step>
          <Step n={2} title="Activate your builder code">
            Optional. Fund your own Hyperliquid builder address once and every fill in your app pays the fee to you.
            Skip it and the app still runs in preview.
          </Step>
          <Step n={3} title="Launch your coin">
            Optional. A creator token on Robinhood Chain via Pons. Pledge a share of your builder fees to buybacks and
            burns, shown on-chain.
          </Step>
        </ol>
      </section>

      {/* Earnings hook */}
      <EarningsHook launchTo={launchTo} />

      {/* Two sides */}
      <section className="mt-10 sm:mt-12">
        <SectionHead
          eyebrow="Who it's for"
          title="Built for the creator. Trusted by the trader."
          sub="Both sides see the same app, the same fee, and the same on-chain record."
        />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <SideCard
            tone="builder"
            title="For builders & creators"
            cta={{ to: launchTo, label: 'Start building' }}
            items={[
              {
                icon: <IconPercent size={15} />,
                title: 'Keep 100% of your builder fee',
                body: 'You set 0–10 bps per fill. BuilderPad takes no cut of it — the platform fee is a one-time $5 activation.',
              },
              {
                icon: <IconGlobe size={15} />,
                title: 'Your handle or your domain',
                body: `Live at {you}.${TENANT_BASE_DOMAIN}, or point your own domain at it. Your logo, your name, your socials.`,
              },
              {
                icon: <IconTwitch size={15} />,
                title: 'Stream in the app',
                body: 'Connect Twitch and your live stream sits inside the trading terminal while you trade with your audience.',
              },
              {
                icon: <IconBuyback size={15} />,
                title: 'A coin your fees buy back',
                body: 'Launch a creator token and pledge a share of builder fees to buybacks and burns. Fee changes are append-only and public.',
              },
            ]}
          />
          <SideCard
            tone="trader"
            title="For traders, fans & investors"
            cta={{ to: '/explore', label: 'Explore creators' }}
            items={[
              {
                icon: <IconWallet size={15} />,
                title: 'Self-custody, one login',
                body: 'Sign in with email, Google or a wallet. You get a Privy embedded wallet — your keys, exportable any time.',
              },
              {
                icon: <IconLock size={15} />,
                title: 'Hyperliquid underneath',
                body: 'Orders go straight to Hyperliquid. Same books, same liquidity, same speed as trading there directly.',
              },
              {
                icon: <IconStock size={15} />,
                title: 'Diverse markets',
                body: 'Crypto perps and spot, plus HIP-3 books for stocks, indices and commodities — whatever the creator lists.',
              },
              {
                icon: <IconCoin size={15} />,
                title: 'Back who you follow',
                body: 'See exactly what a creator charges and earns. Buy their coin, watch the buybacks, trade while they stream.',
              },
            ]}
          />
        </div>
      </section>

      {/* Markets strip */}
      <section className="mt-10 grid gap-3 sm:grid-cols-4 sm:mt-12">
        <MarketPill icon={<IconChart size={14} />} label="Crypto perps" sub="BTC, ETH, HYPE, SOL…" />
        <MarketPill icon={<IconSpot size={14} />} label="Spot" sub="HYPE, PURR, USDC pairs" />
        <MarketPill icon={<IconStock size={14} />} label="Stocks & indices" sub="NVDA, TSLA, SP500, NDX" />
        <MarketPill icon={<IconCommodity size={14} />} label="Commodities & FX" sub="Gold, oil, silver, EUR" />
      </section>

      {/* Final CTA */}
      <section className="card-pop mt-10 flex flex-col items-start justify-between gap-5 p-6 sm:mt-12 sm:flex-row sm:items-center sm:p-8">
        <div>
          <h2 className="display text-3xl sm:text-4xl">
            Ready to <span className="text-hype">own</span> your fee?
          </h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-fg-muted">
            Open source, self-custody, no intermediaries. Publish today in preview, activate when you want the fee.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2.5">
          <Link to={launchTo} className="btn-hype px-5 py-3 text-sm">
            <IconRocket size={16} /> Launch
          </Link>
          <Link to="/explore" className="btn-ghost px-5 py-3 text-sm">
            Explore
          </Link>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function EarningsHook({ launchTo }: { launchTo: string }) {
  const [tenths, setTenths] = useState(100);
  const [volume, setVolume] = useState(1_000_000_000);
  const take = feeTake(tenths, volume);
  const pct = (tenths / 1000).toFixed(tenths % 10 === 0 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '');

  return (
    <section className="card-pop mt-10 overflow-hidden sm:mt-12">
      <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
        <div>
          <p className="eyebrow">Do the math</p>
          <h2 className="display mt-2 text-3xl sm:text-4xl">What your fee is worth.</h2>
          <p className="mt-3 text-sm leading-6 text-fg-muted">
            Hyperliquid pays builders per fill. Pick a fee and a volume — this is the number that lands in your builder
            wallet, not ours.
          </p>
          <Link to={launchTo} className="btn-primary mt-5 px-5 py-2.5 text-sm">
            <IconRocket size={15} /> Set my fee
          </Link>
        </div>
        <div className="rounded-2xl border border-stroke-weak bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-full text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle sm:w-auto">
              Fee
            </span>
            {FEE_OPTIONS.map((o) => (
              <button
                key={o.tenths}
                type="button"
                className="chip"
                aria-pressed={tenths === o.tenths}
                onClick={() => setTenths(o.tenths)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="w-full text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle sm:w-auto">
              Volume
            </span>
            {VOLUME_OPTIONS.map((o) => (
              <button
                key={o.usd}
                type="button"
                className="chip"
                aria-pressed={volume === o.usd}
                onClick={() => setVolume(o.usd)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mt-5 border-t border-stroke-weak pt-4">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">You earn</div>
            <div className="display mt-1 text-4xl tabular text-hype sm:text-5xl">{formatEarnUsd(take)}</div>
            <div className="mt-1.5 text-[11px] font-semibold text-fg-subtle">
              {pct}% of {formatCompactUsd(volume)} traded · paid by Hyperliquid on every fill · 0% to BuilderPad
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="display mt-2 text-3xl sm:text-4xl">{title}</h2>
      {sub ? <p className="mt-2 max-w-xl text-sm leading-6 text-fg-muted">{sub}</p> : null}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="card relative p-5">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-[13px] font-black text-black">
        {n}
      </span>
      <h3 className="mt-3 text-[15px] font-extrabold">{title}</h3>
      <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">{children}</p>
    </li>
  );
}

function SideCard({
  tone,
  title,
  items,
  cta,
}: {
  tone: 'builder' | 'trader';
  title: string;
  items: { icon: ReactNode; title: string; body: string }[];
  cta: { to: string; label: string };
}) {
  const builder = tone === 'builder';
  return (
    <div className={`card flex flex-col p-5 sm:p-6 ${builder ? 'border-brand/30' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[17px] font-extrabold">{title}</h3>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] ${
            builder ? 'bg-brand-soft text-brand' : 'bg-fill-weak text-fg-muted'
          }`}
        >
          {builder ? 'Earn' : 'Trade'}
        </span>
      </div>
      <ul className="mt-4 grid gap-3.5">
        {items.map((it) => (
          <li key={it.title} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                builder ? 'bg-brand-soft text-brand' : 'bg-fill-weak text-fg'
              }`}
            >
              {it.icon}
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-extrabold">{it.title}</div>
              <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{it.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <Link to={cta.to} className={`${builder ? 'btn-primary' : 'btn-ghost'} mt-5 w-fit px-4 py-2.5 text-sm`}>
        {cta.label}
      </Link>
    </div>
  );
}

function MarketPill({ icon, label, sub }: { icon: ReactNode; label: string; sub: string }) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-fill-weak text-fg">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-extrabold">{label}</div>
        <div className="truncate text-[11px] font-semibold text-fg-subtle">{sub}</div>
      </div>
    </div>
  );
}

function HeroStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">{label}</div>
        <div className="mt-0.5 text-lg font-black tabular text-fg">{value}</div>
      </div>
    </div>
  );
}
