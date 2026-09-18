import { formatCompactUsd } from '../lib/earnings';
import type { AssetRow } from '../lib/tenants';
import type { SocialProvider, VerifiedSocials } from '../lib/auth';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther, formatUnits, type Address } from 'viem';
import { displaySymbol, fetchMidsForCoins, num } from '../lib/hlMarket';
import { isNativeQuote, readFeePolicy, readLaunchFee, readLaunchTerms, readSnipeTax } from '../lib/pons';
import { parseTeamWallets, type CoinTerms } from './CoinTermsFields';
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

type Props = {
  appName: string;
  slug: string;
  description: string;
  logoUrl: string;
  feeTenths: number;
  buybackPct: number;
  burnPct: number;
  notional: number;
  markets: AssetRow[];
  liveOwn: boolean;
  tokenSymbol: string;
  quoteLabel: string;
  chain: 'robinhood' | 'hyperevm';
  socials: VerifiedSocials & { website: string };
  show: Record<SocialProvider, boolean>;
  /** Token chapter terms — drives the launch spec rows. Omit to hide them. */
  coin?: CoinTerms;
};

function fmtQuote(raw: bigint, decimals: number): string {
  const v = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fmtBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function fmtSupply(raw: bigint): string {
  const v = Number(formatUnits(raw, 18));
  if (v >= 1e9) return `${(v / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })}B`;
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  return v.toLocaleString('en-US');
}

function markFromCatalog(markets: AssetRow[], quoteSym: string): number | null {
  const want = quoteSym.toUpperCase();
  for (const a of markets) {
    const base = displaySymbol(a.coin, a.symbol).toUpperCase();
    const sym = (a.symbol || '').toUpperCase();
    const coin = a.coin.toUpperCase();
    if (base === want || sym === want || coin === want || coin.endsWith(`:${want}`)) {
      const px = num(a.markPx);
      if (px != null && px > 0) return px;
    }
  }
  return null;
}

async function quoteUsdPrice(
  quoteSym: string,
  pairToken: string,
  markets: AssetRow[],
): Promise<number | null> {
  const sym = quoteSym.toUpperCase();
  if (sym === 'USDG' || sym === 'USDC' || sym === 'USDT') return 1;
  if (isNativeQuote(pairToken) || sym === 'ETH') {
    const m = await fetchMidsForCoins(['ETH']);
    return m.get('ETH') ?? null;
  }
  const fromCatalog = markFromCatalog(markets, sym);
  if (fromCatalog != null) return fromCatalog;
  const candidates = [`xyz:${sym}`, sym];
  const m = await fetchMidsForCoins(candidates);
  for (const c of candidates) {
    const px = m.get(c);
    if (px != null && px > 0) return px;
  }
  return null;
}

export function LaunchPreview({
  appName,
  slug,
  logoUrl,
  markets,
  tokenSymbol,
  quoteLabel,
  chain,
  socials,
  show,
  coin,
}: Props) {
  const name = appName.trim() || 'Your app';
  const handle = slug.trim() || 'your-app';
  const ticker = (tokenSymbol || 'TOKEN').toUpperCase();
  const quoteSym = quoteLabel.replace(/\s.*/, '') || 'ETH';

  // Live factory terms for the chosen quote asset — same reads the launch itself uses.
  const pairToken = coin?.pairToken;
  const launchTerms = useQuery({
    queryKey: ['pons-launch-terms', pairToken],
    enabled: !!coin && !!pairToken,
    queryFn: () => readLaunchTerms(pairToken as Address),
    staleTime: 60_000,
  });
  const launchFee = useQuery({ queryKey: ['pons-launch-fee'], enabled: !!coin, queryFn: readLaunchFee, staleTime: 5 * 60_000 });
  const snipe = useQuery({ queryKey: ['pons-snipe-tax'], enabled: !!coin, queryFn: readSnipeTax, staleTime: 5 * 60_000 });
  const policy = useQuery({ queryKey: ['pons-fee-policy'], enabled: !!coin, queryFn: readFeePolicy, staleTime: 5 * 60_000 });
  const t = launchTerms.data;
  const qDec = t?.quoteDecimals ?? 18;
  const openingQuoteN = t ? Number(formatUnits(t.phantomQuote, qDec)) : null;
  const quoteUsd = useQuery({
    queryKey: ['launch-preview-quote-usd', quoteSym, pairToken],
    enabled: !!coin && !!pairToken && openingQuoteN != null,
    queryFn: () => quoteUsdPrice(quoteSym, pairToken as string, markets),
    staleTime: 60_000,
  });
  const openingUsd =
    openingQuoteN != null && quoteUsd.data != null && Number.isFinite(quoteUsd.data)
      ? openingQuoteN * quoteUsd.data
      : null;
  const devBuy = coin?.devBuy.trim();
  const hasDevBuy = !!devBuy && Number(devBuy) > 0;
  const teamCount = coin ? parseTeamWallets(coin.teamWallets).valid.length : 0;
  const creatorSharePct = policy.data ? (10_000 - policy.data.protocolShareBps) / 100 : null;
  const openingMcap = t ? fmtQuote(t.phantomQuote, qDec) : null;
  // Token chapter: pair against the chosen quote. Earlier chapters: a sample HL market.
  const pairRight = coin
    ? quoteSym
    : markets.find((m) => m.coin.includes(':'))?.symbol ||
      markets[0]?.symbol ||
      quoteSym ||
      'NVDA';
  const marketTitle = /markets$/i.test(name) ? name : `${name} Markets`;
  void chain; // prop kept for callers; footer no longer prints the chain name
  const icons = [
    show.youtube && socials.youtube ? { key: 'yt', node: <IconYouTube size={13} /> } : null,
    show.twitter && socials.twitter ? { key: 'x', node: <IconX size={13} /> } : null,
    show.tiktok && socials.tiktok ? { key: 'tt', node: <IconTikTok size={13} /> } : null,
    show.twitch && socials.twitch ? { key: 'tw', node: <IconTwitch size={13} /> } : null,
    show.instagram && socials.instagram ? { key: 'ig', node: <IconInstagram size={13} /> } : null,
    show.discord && socials.discord ? { key: 'dc', node: <IconDiscord size={13} /> } : null,
    show.telegram && socials.telegram ? { key: 'tg', node: <IconTelegram size={13} /> } : null,
    socials.website.trim() ? { key: 'web', node: <IconGlobe size={13} /> } : null,
  ].filter(Boolean) as { key: string; node: ReactNode }[];

  return (
    <aside className="scroll-brand flex flex-col gap-2.5 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
      <div className="inline-flex w-fit items-center gap-2 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-[11px] font-extrabold text-brand shadow-[0_0_18px_color-mix(in_srgb,var(--text-brand)_28%,transparent)]">
        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-brand" />
        Preview
      </div>

      <div className="card-pop overflow-hidden">
        <div className="px-3.5 pb-3 pt-3.5">
          <div className="flex items-start gap-2.5">
            {logoUrl.trim() ? (
              <img src={logoUrl.trim()} alt="" className="h-11 w-11 rounded-full object-cover" />
            ) : (
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-lg font-black text-black">
                {name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15px] font-extrabold">{name}</span>
                <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[#3b82f6] text-white">
                  <IconCheck size={8} strokeWidth={4} />
                </span>
              </div>
              <div className="text-[12px] text-fg-subtle">@{handle}</div>
            </div>
          </div>
          {icons.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {icons.map((ic) => (
                <span
                  key={ic.key}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted"
                >
                  {ic.node}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mx-3 mb-3 rounded-xl border border-stroke-weak bg-sunken/70 p-2.5 sm:p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {logoUrl.trim() ? (
                <img src={logoUrl.trim()} alt="" className="h-7 w-7 rounded-full object-cover" />
              ) : (
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[10px] font-black text-black">
                  {ticker.slice(0, 1)}
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-[13px] font-extrabold">{marketTitle}</div>
                <div className="text-[10px] font-bold text-fg-subtle">
                  {ticker} / {pairRight}
                </div>
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-extrabold text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Live
            </span>
          </div>

          <div className="mt-2.5">
            {coin ? (
              <>
                <div className="flex items-end gap-2">
                  <span className="text-[20px] font-black tabular leading-none sm:text-[22px]">
                    {openingMcap ? `${openingMcap} ${quoteSym}` : '…'}
                  </span>
                  <span className="pb-0.5 text-[11px] font-extrabold text-fg-subtle">opening mcap</span>
                </div>
                {openingUsd != null ? (
                  <div className="mt-1 text-[11px] font-semibold tabular text-fg-subtle">
                    ≈ {formatCompactUsd(openingUsd)}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex items-end gap-2">
                <span className="text-[22px] font-black tabular leading-none">$0.0034</span>
                <span className="pb-0.5 text-[12px] font-extrabold text-market-up">+12.5%</span>
              </div>
            )}
          </div>

          <PreviewChart compact={!!coin} />

          {coin ? (
            <dl className="mt-2 border-t border-stroke-weak pt-0.5 text-[11px]">
              <SpecRow label="Launch fee" value={launchFee.data != null ? `${formatEther(launchFee.data)} ETH` : '…'} />
              <SpecRow label="Paired with" value={quoteSym} />
              <SpecRow label="Trade fee" value={t ? fmtBps(Number(t.config.curveFeeBps)) : '…'} />
              <SpecRow
                label="You keep"
                value={
                  creatorSharePct != null
                    ? `${creatorSharePct}% of fees${coin.creatorTaxBps > 0 ? ` + ${fmtBps(coin.creatorTaxBps)} tax` : ''}`
                    : '…'
                }
              />
              <SpecRow
                label="Launch window"
                value={snipe.data ? `${fmtBps(snipe.data.startBps)} snipe tax, ${snipe.data.seconds}s` : '…'}
              />
              <SpecRow label="Developer buy" value={hasDevBuy ? `${devBuy} ${quoteSym}` : 'None'} />
              <SpecRow
                label="Buybacks"
                value={
                  coin.buybackEnabled
                    ? policy.data
                      ? `On · ${fmtBps(policy.data.buybackBurnBps)} of your fees`
                      : 'On'
                    : 'Off'
                }
              />
              <SpecRow label="Supply" value={t ? fmtSupply(t.config.supply) : '…'} />
              <SpecRow label="Graduation" value={t ? `${fmtQuote(t.graduationThreshold, qDec)} ${quoteSym}` : '…'} />
              <SpecRow label="Liquidity" value="Locked" />
              {teamCount ? <SpecRow label="Team wallets" value={`${teamCount} exempt`} /> : null}
            </dl>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-stroke-weak pt-3">
              <MiniStat label="Market cap" value="$3.4M" />
              <MiniStat label="24h volume" value="$1.2M" />
              <MiniStat label="Holders" value="12.4K" />
            </div>
          )}
        </div>

        <div className="px-3 pb-3">
          <button type="button" tabIndex={-1} className="btn-primary w-full py-2.5 text-sm">
            Trade
          </button>
        </div>
      </div>
    </aside>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-stroke-weak/60 py-1 last:border-b-0">
      <dt className="font-semibold text-fg-subtle">{label}</dt>
      <dd className="truncate text-right font-extrabold tabular text-fg">{value}</dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-fg-subtle">{label}</div>
      <div className="mt-0.5 text-[12px] font-black tabular">{value}</div>
    </div>
  );
}

function PreviewChart({ compact }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 280 88"
      className={`mt-2.5 w-full text-brand ${compact ? 'h-[64px] lg:h-[56px]' : 'h-[88px]'}`}
      aria-hidden
    >
      <defs>
        <linearGradient id="bp-preview-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[22, 44, 66].map((y) => (
        <line key={y} x1="0" y1={y} x2="280" y2={y} stroke="#ffffff14" strokeWidth="1" />
      ))}
      <path
        d="M0 70 C 28 68, 42 62, 56 58 C 84 50, 98 54, 112 46 C 140 34, 154 38, 168 28 C 196 16, 224 22, 252 12 L 280 8 L 280 88 L 0 88 Z"
        fill="url(#bp-preview-fill)"
      />
      <path
        d="M0 70 C 28 68, 42 62, 56 58 C 84 50, 98 54, 112 46 C 140 34, 154 38, 168 28 C 196 16, 224 22, 252 12 L 280 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
