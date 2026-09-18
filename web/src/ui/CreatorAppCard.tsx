import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import {
  formatCompactUsd,
  formatEarnedUsd,
  formatTaxBps,
  formatUsdPrice,
  relativeAgo,
} from '../lib/earnings';
import { displayEarnedUsd, displayVolumeUsd, isExternalCoin, shortAddr, type TenantPublic } from '../lib/tenants';
import { fetchCurveTradeFeeBps, formatGraduationPct } from '../lib/pons';
import { CreatorByline } from './CreatorByline';
import { ROBINHOOD_CHAIN_ID, robinhoodTokenUrl } from '../lib/pons/chain';
import type { CoinMarket } from '../lib/pons/market';
import {
  IconBolt,
  IconBurn,
  IconBuyback,
  IconChart,
  IconCheck,
  IconCoin,
  IconCopy,
  IconCandles,
  IconPercent,
} from './icons';
import { BuilderFeeValue } from './BuilderFee';
import { PledgeValue } from './AppPledge';
import { TokenBuybackValue } from './TokenBuyback';
import { socialItems } from './socials';
import { AppHref } from './AppHref';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';

export function CopyCa({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={
        className ??
        'inline-flex items-center gap-1 rounded-md px-0.5 font-mono text-[11px] font-bold text-fg-subtle hover:text-fg'
      }
      aria-label={copied ? 'Copied' : 'Copy contract'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {shortAddr(value)}
      {copied ? <IconCheck size={11} className="text-success" /> : <IconCopy size={11} />}
    </button>
  );
}

function Trait({
  title,
  on,
  children,
}: {
  title: string;
  on: boolean;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${
        on ? 'bg-brand-soft text-brand' : 'text-fg-subtle/35'
      }`}
    >
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <div className="inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
        <span className="text-brand">{icon}</span>
        {label}
      </div>
      <div className="mt-0.5 w-full text-[13px] font-black tabular text-fg">{value}</div>
    </div>
  );
}

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-8 shrink-0 items-center justify-center self-center text-[9px] font-extrabold uppercase tracking-[0.1em] text-fg-subtle">
      {children}
    </div>
  );
}

function formatMcap(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n < 1000 ? formatUsdPrice(n) : formatCompactUsd(n);
}

export function CreatorAppCard({
  tenant: t,
  market,
  appEarnedUsd,
  tokenEarnedUsd,
  to,
  trailing,
  badge,
  footer,
  onEditFee,
  onEditPledge,
  onEditBurn,
  onEditBuyback,
  /** Full-width My projects list — App/Token label beside all 5 stats. */
  layout = 'stack',
}: {
  tenant: TenantPublic;
  market?: CoinMarket;
  /** HL builder fees for the App row. Omit → displayEarnedUsd(tenant). */
  appEarnedUsd?: number | null;
  /** Pons escrow + unswept curve fees in USD. Null/omit → N/A while loading or no coin. */
  tokenEarnedUsd?: number | null;
  to: string;
  trailing?: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  onEditFee?: () => void;
  onEditPledge?: () => void;
  onEditBurn?: () => void;
  onEditBuyback?: () => void;
  layout?: 'stack' | 'wide';
}) {
  const coin = t.coin;
  const hasApp = t.status === 'live';
  const hasToken = !!coin;
  const age = relativeAgo(coin?.launched_at || t.created_at);
  const appVol = displayVolumeUsd(t);
  const earned = appEarnedUsd != null ? appEarnedUsd : displayEarnedUsd(t);
  const symbol = (coin?.symbol || '').toUpperCase();
  const socials = socialItems(t);
  const grad = market?.graduation;
  const showBar = !!coin && !!grad && !grad.graduated;
  const onRobinhood = !!coin && coin.chain_id === ROBINHOOD_CHAIN_ID;
  const na = 'N/A';
  const tokenEarnedLabel = !coin
    ? na
    : coin.earned_usd != null && Number.isFinite(coin.earned_usd)
      ? formatEarnedUsd(coin.earned_usd)
      : tokenEarnedUsd == null
        ? '—'
        : formatEarnedUsd(tokenEarnedUsd);
  const tradeFeeQ = useQuery({
    queryKey: ['pons-trade-fee', coin?.curve],
    enabled: !!coin?.curve && coin.trade_fee_bps == null,
    queryFn: () => fetchCurveTradeFeeBps(coin!.curve as Address),
    staleTime: 60_000,
  });
  const tradeFeeLabel =
    coin?.trade_fee_bps != null
      ? formatTaxBps(coin.trade_fee_bps)
      : coin && tradeFeeQ.data != null
        ? formatTaxBps(tradeFeeQ.data)
        : coin
          ? '—'
          : na;
  const wide = layout === 'wide';

  const buybackStat = (
    <span className="pointer-events-auto">
      <Stat
        icon={<IconBuyback size={11} />}
        label="Buybacks"
        value={
          <PledgeValue
            label="Buybacks"
            pct={t.buyback_pct ?? 0}
            history={t.buyback_history}
            hideLabel
            compact
            onEdit={onEditPledge}
          />
        }
      />
    </span>
  );
  const burnStat = (
    <span className="pointer-events-auto">
      <Stat
        icon={<IconBurn size={11} />}
        label="Burn"
        value={
          <PledgeValue
            label="Burn"
            pct={t.burn_pct ?? 0}
            history={t.burn_history}
            hideLabel
            compact
            onEdit={onEditBurn}
          />
        }
      />
    </span>
  );
  const buybacksStat = (
    <span className="pointer-events-auto">
      <Stat
        icon={<IconBuyback size={11} />}
        label="Buybacks"
        value={
          coin ? (
            <TokenBuybackValue
              enabled={!!coin.buyback_enabled}
              onEdit={isExternalCoin(coin) ? undefined : onEditBuyback}
            />
          ) : (
            na
          )
        }
      />
    </span>
  );

  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col hover:bg-fill-weaker">
        <AppHref to={to} className="absolute inset-0 z-0" aria-label={t.app_name} />
        <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 flex-col">
          <div className="flex items-start gap-3 px-4 pt-4">
            {t.logo_url ? (
              <img src={t.logo_url} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-black text-black">
                {(t.app_name || '?').slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15px] font-extrabold">{t.app_name}</span>
                {socials.length ? (
                  <span className="pointer-events-auto flex shrink-0 items-center gap-0.5">
                    {socials.map((s) => (
                      <a
                        key={s.href}
                        href={s.href}
                        target="_blank"
                        rel="noreferrer"
                        title={s.title}
                        aria-label={s.title}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
                      >
                        <s.Icon size={12} />
                      </a>
                    ))}
                  </span>
                ) : null}
                {badge ? <span className="pointer-events-auto shrink-0">{badge}</span> : null}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                {symbol ? (
                  <span className="font-mono text-[12px] font-bold text-brand">${symbol}</span>
                ) : (
                  <span className="truncate text-[12px] font-bold text-fg-subtle">@{t.slug}</span>
                )}
                {coin ? (
                  <span className="pointer-events-auto">
                    <Trait
                      title={
                        coin.buyback_enabled
                          ? 'Buyback on — curve fees buy the token for holders'
                          : 'Buyback off — curve fees do not buy the token'
                      }
                      on={!!coin.buyback_enabled}
                    >
                      <IconBuyback size={12} />
                    </Trait>
                  </span>
                ) : null}
              </div>
              {t.creator && t.creator.apps.length > 1 ? (
                <div className="pointer-events-auto mt-0.5 min-w-0">
                  <CreatorByline creator={t.creator} />
                </div>
              ) : null}
              {coin?.token ? (
                <div className="pointer-events-auto mt-1 flex items-center gap-1">
                  <CopyCa value={coin.token} />
                  {onRobinhood ? (
                    <a
                      href={robinhoodTokenUrl(coin.token)}
                      target="_blank"
                      rel="noreferrer"
                      title="Robinhood Chain"
                      aria-label="Robinhood Chain"
                    >
                      <img src={robinhoodIcon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="pointer-events-auto flex shrink-0 items-start gap-1.5">
              <Trait
                title={t.status === 'live' ? 'Trading app live' : 'App not published yet'}
                on={t.status === 'live'}
              >
                <IconCandles size={12} />
              </Trait>
              {trailing}
            </div>
          </div>

          <div className="mt-auto px-4 pb-3 pt-3">
            {wide ? (
              <>
                <div
                  className={`grid grid-cols-[2rem_repeat(5,minmax(0,1fr))] items-center gap-2 ${
                    !hasApp ? 'opacity-40' : ''
                  }`}
                >
                  <RowLabel>App</RowLabel>
                  <Stat icon={<IconChart size={11} />} label="Volume" value={formatCompactUsd(appVol)} />
                  <Stat icon={<IconBolt size={11} />} label="Earned" value={formatEarnedUsd(earned)} />
                  <span className="pointer-events-auto">
                    <Stat
                      icon={<IconPercent size={11} />}
                      label="Builder Fee"
                      value={
                        <BuilderFeeValue
                          tenths={t.builder_fee_tenths ?? 0}
                          history={t.builder_fee_history}
                          onEdit={onEditFee}
                        />
                      }
                    />
                  </span>
                  {buybackStat}
                  {burnStat}
                </div>
                <div
                  className={`mt-3 grid grid-cols-[2rem_repeat(5,minmax(0,1fr))] items-center gap-2 border-t border-stroke-weak pt-3 ${
                    !hasToken ? 'opacity-40' : ''
                  }`}
                >
                  <RowLabel>Token</RowLabel>
                  <Stat icon={<IconBolt size={11} />} label="Earned" value={tokenEarnedLabel} />
                  <Stat icon={<IconCoin size={11} />} label="Mcap" value={coin ? formatMcap(market?.mcapUsd) : na} />
                  <Stat icon={<IconPercent size={11} />} label="Trade fee" value={tradeFeeLabel} />
                  {buybacksStat}
                  <Stat
                    icon={<IconPercent size={11} />}
                    label="Creator Tax"
                    value={coin ? formatTaxBps(coin.creator_tax_bps) : na}
                  />
                </div>
              </>
            ) : (
              <>
                <div className={`flex items-center gap-2 ${!hasApp ? 'opacity-40' : ''}`}>
                  <RowLabel>App</RowLabel>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <Stat icon={<IconChart size={11} />} label="Volume" value={formatCompactUsd(appVol)} />
                      <Stat icon={<IconBolt size={11} />} label="Earned" value={formatEarnedUsd(earned)} />
                      <span className="pointer-events-auto">
                        <Stat
                          icon={<IconPercent size={11} />}
                          label="Builder Fee"
                          value={
                            <BuilderFeeValue
                              tenths={t.builder_fee_tenths ?? 0}
                              history={t.builder_fee_history}
                              onEdit={onEditFee}
                            />
                          }
                        />
                      </span>
                    </div>
                    {/* Homepage cards: buybacks + burn live on the creator page.
                    <div className="grid grid-cols-2 gap-2">
                      {buybackStat}
                      {burnStat}
                    </div>
                    */}
                  </div>
                </div>
                <div
                  className={`mt-3 flex items-center gap-2 border-t border-stroke-weak pt-3 ${
                    !hasToken ? 'opacity-40' : ''
                  }`}
                >
                  <RowLabel>Token</RowLabel>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <Stat icon={<IconBolt size={11} />} label="Earned" value={tokenEarnedLabel} />
                      <Stat
                        icon={<IconCoin size={11} />}
                        label="Mcap"
                        value={coin ? formatMcap(market?.mcapUsd) : na}
                      />
                      <Stat icon={<IconPercent size={11} />} label="Trade fee" value={tradeFeeLabel} />
                    </div>
                    {/* Homepage cards: token buybacks + creator tax live on the creator page.
                    <div className="grid grid-cols-2 gap-2">
                      {buybacksStat}
                      <Stat
                        icon={<IconPercent size={11} />}
                        label="Creator Tax"
                        value={coin ? formatTaxBps(coin.creator_tax_bps) : na}
                      />
                    </div>
                    */}
                  </div>
                </div>
              </>
            )}
            <div className="mt-3 flex items-center gap-2">
              {showBar ? (
                <>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-weak">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${Math.max(2, Math.min(100, grad.pct))}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10px] font-bold tabular text-fg-subtle">
                    {formatGraduationPct(grad.pct)}
                  </span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              {age ? <span className="shrink-0 text-[10px] font-bold text-fg-subtle">{age}</span> : null}
            </div>
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}
