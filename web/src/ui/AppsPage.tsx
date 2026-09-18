import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebAuth } from '../lib/auth';
import { listMyTenants, patchTenant, deleteTenantDraft } from '../lib/api';
import { builderTakeUsd, formatCompactUsd, formatUsdPrice, PREVIEW_NOTIONAL_USD } from '../lib/earnings';
import { displayEarnedUsd, displayOrders, displayVolumeUsd, isExternalCoin, shortAddr, type TenantPublic } from '../lib/tenants';
import { marketFor, useCoinMarkets } from '../lib/useCoinMarkets';
import { earnedFor, useCreatorEarnedUsd } from '../lib/useCreatorEarnedUsd';
import { fetchHlRewards, type Hex } from '../lib/hlTrade';
import { PRIVY_APP_ID, tenantAppHref } from '../lib/config';
import { isImportedBuilderRejected, useEnsureBuilderWallets } from '../lib/useEnsureBuilderWallets';
import { BuilderActivateCard, BuilderProvisionFallback } from './BuilderActivateCard';
import { BuilderFeeEditDialog } from './BuilderFee';
import { PledgeEditDialog } from './AppPledge';
import { TokenBuybackEditDialog } from './TokenBuyback';
import { CoinFeesCard } from './CoinFeesCard';
import { CreatorAppCard, CopyCa } from './CreatorAppCard';
import { AppHref } from './AppHref';
import { CustomDomainBadge } from './CustomDomainCard';
import { StreamDeskCard } from './StreamDeskCard';
import { HlFeesCard } from './HlFeesCard';
import { LaunchCoinLater } from './LaunchCoinLater';
import { IconArrow, IconBolt, IconChart, IconCheck, IconCopy, IconCoin, IconRocket, IconWallet } from './icons';
import { RollingUsd } from './Rolling';
import { AppsHeroSkeleton, AppsListSkeleton, BuilderActivateSkeleton } from './skeleton';
import { robinhoodTokenUrl } from '../lib/pons/chain';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';

function uniqueBuilderStat(apps: TenantPublic[], pick: (t: TenantPublic) => number): number {
  const by = new Map<string, number>();
  for (const row of apps) {
    const key = (row.builder_address || row.id).toLowerCase();
    by.set(key, Math.max(by.get(key) ?? 0, pick(row)));
  }
  return [...by.values()].reduce((sum, n) => sum + n, 0);
}

function usdTiny(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  // Match formatEarnedUsd: no 4-decimal dust mid-roll (avoids $0.0000 while tweening to 0).
  if (abs < 0.1) return '$0';
  if (abs < 1000) return `$${abs.toFixed(2)}`;
  return formatCompactUsd(v);
}

function formatMcap(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n < 1000 ? formatUsdPrice(n) : formatCompactUsd(n);
}

export function AppsPage() {
  const { authenticated, getAccessToken, privyConfigured, login, hydrating } = useWebAuth();
  const qc = useQueryClient();
  const pair = useEnsureBuilderWallets();
  const [builderCopied, setBuilderCopied] = useState(false);
  const [heroTab, setHeroTab] = useState<'apps' | 'tokens'>('apps');
  const [feeEdit, setFeeEdit] = useState<TenantPublic | null>(null);
  const [feeBusy, setFeeBusy] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [pledgeEdit, setPledgeEdit] = useState<{ tenant: TenantPublic; kind: 'buyback' | 'burn' } | null>(null);
  const [pledgeBusy, setPledgeBusy] = useState(false);
  const [pledgeError, setPledgeError] = useState<string | null>(null);
  const [buybackEdit, setBuybackEdit] = useState<TenantPublic | null>(null);
  const [discard, setDiscard] = useState<TenantPublic | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const mine = useQuery({
    queryKey: ['my-tenants'],
    enabled: authenticated,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listMyTenants(token);
    },
  });

  const apps = mine.data ?? [];
  const coinMarkets = useCoinMarkets(apps.map((t) => t.coin));
  const earnedMap = useCreatorEarnedUsd(apps.map((t) => t.coin));
  const hasDraft = apps.some((t) => t.status === 'draft');
  const liveOwn = pair.data?.live === 'own';
  const platformBuilder = (pair.data?.platform_builder || '').toLowerCase();
  const previewCapped =
    !liveOwn &&
    apps.some(
      (t) => t.status === 'live' && platformBuilder && t.builder_address.toLowerCase() === platformBuilder,
    );
  const hlPaying = !!pair.data?.hl?.ready;
  const settledTotal = uniqueBuilderStat(apps, displayEarnedUsd);
  const volumeTotal = uniqueBuilderStat(apps, displayVolumeUsd);
  const orders = uniqueBuilderStat(apps, displayOrders);
  const deskSettled = apps.reduce((s, r) => s + (r.attribution?.settled_builder_fee_usd ?? 0), 0);
  const builderAddr = pair.data?.builder_wallet ?? '';
  const hlRewards = useQuery({
    queryKey: ['hl-referral', builderAddr.toLowerCase()],
    enabled: !!builderAddr && liveOwn,
    queryFn: () => fetchHlRewards(builderAddr as Hex),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  /** HL builder-code take (referral.builderRewards), else tenant-attached max. */
  const appEarnedTotal = Math.max(hlRewards.data?.builder ?? 0, settledTotal);
  const hasEarnings = liveOwn && (deskSettled > 0 || appEarnedTotal > 0);
  const coins = apps.filter((t) => t.coin?.token);
  const tokenEarnedTotal = coins.reduce((s, t) => {
    const n = earnedFor(earnedMap.data, t.coin?.token);
    return s + (n != null && Number.isFinite(n) ? n : 0);
  }, 0);
  const tokenMcap = coins.reduce((s, t) => {
    const m = marketFor(coinMarkets.data, t.coin?.token);
    const n = m?.mcapUsd;
    return s + (n != null && Number.isFinite(n) ? n : 0);
  }, 0);
  const primaryCoinApp = coins[0] ?? null;
  const primaryCoin = primaryCoinApp?.coin ?? null;

  const copyBuilder = async () => {
    if (!builderAddr) return;
    try {
      await navigator.clipboard.writeText(builderAddr);
      setBuilderCopied(true);
      window.setTimeout(() => setBuilderCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  // Creator host → apex is a full reload; wait for Privy before showing the sign-in gate.
  if (hydrating) {
    return (
      <div className="mx-auto max-w-5xl">
        <AppsHeroSkeleton />
        <div className="mt-8">
          <BuilderActivateSkeleton />
        </div>
        <div className="mt-8">
          <AppsListSkeleton />
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <h1 className="display text-4xl">
          My <span className="text-hype">projects</span>
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          Your apps, your tokens, one identity. Sign in to manage them.
        </p>
        {!privyConfigured || !PRIVY_APP_ID ? (
          <p className="card mt-6 px-4 py-3 text-left text-sm text-fg-muted">
            Put <code>VITE_PRIVY_APP_ID</code> in <code>web/.env</code>, restart Vite, add{' '}
            <code>http://localhost:5173</code> to Privy allowed origins.
          </p>
        ) : (
          <button type="button" className="btn-primary mt-8 px-6 py-3 text-sm" onClick={() => login()}>
            Sign in <IconArrow size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl sm:text-5xl">My <span className="text-hype">projects</span></h1>
          <p className="mt-2 max-w-lg text-sm leading-6 text-fg-muted">
            Your apps, your tokens, one identity. Fees from both land in your wallets.
          </p>
        </div>
        <Link to="/create" className="btn-hype px-5 py-3 text-sm">
          <IconRocket size={16} /> {hasDraft ? 'Continue' : 'Launch'}
        </Link>
        {previewCapped && !hasDraft ? (
          <p className="basis-full text-right text-[12px] text-fg-subtle">
            Preview is one live app. Activate to launch another.
          </p>
        ) : null}
      </div>

      <div className="mt-6 flex gap-2">
        <button type="button" className="chip" aria-pressed={heroTab === 'apps'} onClick={() => setHeroTab('apps')}>
          Apps
        </button>
        <button type="button" className="chip" aria-pressed={heroTab === 'tokens'} onClick={() => setHeroTab('tokens')}>
          Tokens
        </button>
      </div>

      {mine.isLoading ? (
        <AppsHeroSkeleton />
      ) : heroTab === 'tokens' ? (
      <section key="hero-tokens" className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="card-money p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-brand">
              <IconBolt size={12} /> Earned
            </div>
            <div className="display mt-2 text-3xl">
              <RollingUsd value={tokenEarnedTotal} format={usdTiny} className="text-hype" />
            </div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              {coins.length ? 'Claim Pons fees on each token below' : 'Launch a token to start earning'}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-fg-muted">
              <IconChart size={12} className="text-brand" /> Mcap
            </div>
            <div className="display mt-2 text-3xl">{coins.length ? formatMcap(tokenMcap) : 'N/A'}</div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              {coins.length > 1 ? `${coins.length} tokens` : 'Across your tokens'}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-fg-subtle">
              <IconCoin size={12} /> Token
            </div>
            {primaryCoin ? (
              <>
                <div className="mt-2 flex min-w-0 items-center gap-2">
                  <CopyCa
                    value={primaryCoin.token}
                    className="inline-flex min-w-0 items-center gap-1 font-mono text-sm font-bold text-fg hover:text-brand"
                  />
                  <a
                    href={robinhoodTokenUrl(primaryCoin.token)}
                    target="_blank"
                    rel="noreferrer"
                    title="Robinhood Chain"
                    aria-label="Robinhood Chain"
                    className="shrink-0"
                  >
                    <img src={robinhoodIcon} alt="" className="h-4 w-4 rounded-sm object-contain" />
                  </a>
                </div>
                <div className="mt-1 text-[11px] text-fg-subtle">
                  ${primaryCoin.symbol.toUpperCase()}
                  {coins.length > 1 ? ` · +${coins.length - 1} more` : ' · Robinhood Chain'}
                </div>
              </>
            ) : (
              <>
                <div className="display mt-2 text-3xl text-fg-subtle">—</div>
                <div className="mt-1 text-[11px] text-fg-subtle">No token launched yet</div>
              </>
            )}
          </div>
        </section>
      ) : (
      <section key="hero-apps" className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="card-money p-4 sm:col-span-1">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-brand">
              <IconBolt size={12} /> Earned
            </div>
            <div className="display mt-2 text-3xl">
              <RollingUsd value={appEarnedTotal} format={usdTiny} className="text-hype" />
            </div>
            {orders > 0 ? (
              <div className="mt-1 text-[11px] text-fg-subtle">{orders} orders</div>
            ) : (
              <div className="mt-1 text-[11px] text-fg-subtle">Hyperliquid builder fees</div>
            )}
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-fg-muted">
              <IconChart size={12} className="text-brand" /> Total volume
            </div>
            <div className="display mt-2 text-3xl">
              <RollingUsd value={volumeTotal} format={formatCompactUsd} className="text-fg" />
            </div>
            <div className="mt-1 text-[11px] text-fg-subtle">Across your apps</div>
          </div>
          <div className="card p-4">
            <div className="flex items-center justify-between text-[11px] font-extrabold uppercase tracking-[0.12em] text-fg-subtle">
              <span className="inline-flex items-center gap-1.5">
                <IconWallet size={12} /> Builder wallet
              </span>
              {liveOwn ? (
                hlPaying ? (
                  <span className="tag-ok">
                    <IconCheck size={9} /> {hasEarnings ? 'collecting' : 'active'}
                  </span>
                ) : (
                  <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-extrabold text-warning">
                    refill
                  </span>
                )
              ) : (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-extrabold text-warning">preview</span>
              )}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-mono text-sm font-bold">
                {builderAddr ? shortAddr(builderAddr) : '…'}
              </span>
              {builderAddr ? (
                <button
                  type="button"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
                  aria-label={builderCopied ? 'Copied' : 'Copy builder wallet'}
                  onClick={() => void copyBuilder()}
                >
                  {builderCopied ? (
                    <IconCheck size={13} className="text-success" />
                  ) : (
                    <IconCopy size={13} />
                  )}
                </button>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-fg-subtle">
              {liveOwn
                ? hlPaying
                  ? apps.length > 0
                    ? 'Every fill pays this address.'
                    : 'Ready. Launch an app to start collecting.'
                  : 'Park 100 USDC on Hyperliquid again to keep collecting.'
                : apps.length > 0
                  ? pair.data?.source === 'imported'
                    ? 'Connected wallet. Activate below to keep the cut.'
                    : 'Activate below to keep the cut.'
                  : 'Launch an app, then you can keep the cut.'}
            </div>
          </div>
        </section>
      )}

      {heroTab === 'tokens' ? (
        <section className="mt-4">
          {primaryCoinApp && primaryCoin ? (
            <div className="card-pop px-5 py-5">
              <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-extrabold">
                <IconCoin size={18} className="text-brand" />
                Token is live on Pons
                <span className="tag-ok">
                  <IconCheck size={9} /> Live
                </span>
              </h2>
              <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
                ${primaryCoin.symbol.toUpperCase()} trades on the bonding curve on your creator page.
              </p>
              <AppHref to={tenantAppHref(primaryCoinApp.slug)} className="btn-hype btn-sm mt-4 px-5 py-2 text-xs">
                Open buy / sell
              </AppHref>
            </div>
          ) : (
            <div className="card px-5 py-5">
              <h2 className="flex items-center gap-2 text-[17px] font-extrabold">
                <IconCoin size={18} className="text-brand" />
                No token yet
              </h2>
              <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
                Launch a token from an app below. Buy and sell then live on the creator page.
              </p>
            </div>
          )}
        </section>
      ) : apps.length > 0 && pair.data ? (
        <section className="mt-4">
          <BuilderActivateCard pair={pair.data} hasEarnings={hasEarnings} />
        </section>
      ) : apps.length > 0 && pair.isLoading ? (
        <section className="mt-4">
          <BuilderActivateSkeleton />
        </section>
      ) : apps.length > 0 && pair.isError ? (
        <section className="mt-4">
          {isImportedBuilderRejected(pair.error) ? (
            <BuilderProvisionFallback
              message={(pair.error as Error).message}
              onCreate={() => pair.createNewBuilder.mutate()}
              creating={pair.createNewBuilder.isPending}
              createError={
                pair.createNewBuilder.isError ? (pair.createNewBuilder.error as Error).message : null
              }
            />
          ) : (
            <p className="card px-5 py-5 text-sm text-fg-muted">
              {(pair.error as Error).message}{' '}
              <button type="button" className="font-bold underline" onClick={() => void pair.refetch()}>
                Retry
              </button>
            </p>
          )}
        </section>
      ) : null}

      <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-extrabold">Projects</h2>
            <span className="text-[12px] font-bold text-fg-subtle">{apps.length}/10</span>
          </div>
          {mine.isLoading ? (
            <AppsListSkeleton />
          ) : mine.isError ? (
            <p className="mt-3 text-sm text-error">{(mine.error as Error).message}</p>
          ) : apps.length === 0 ? (
            <div className="card-pop mt-4 flex flex-wrap items-center justify-between gap-4 p-6">
              <div>
                <div className="text-lg font-extrabold">Nothing live yet.</div>
                <p className="mt-1 text-sm text-fg-muted">
                  0.1% on $1B volume is {formatCompactUsd(builderTakeUsd(100))}. Takes a few minutes.
                </p>
              </div>
              <Link to="/create" className="btn-primary px-5 py-3 text-sm">
                <IconRocket size={16} /> Launch
              </Link>
            </div>
          ) : (
            <>
              <ul className="mt-4 grid gap-3">
                {apps.map((row) => {
                  const ownB =
                    pair.data?.builder_wallet &&
                    row.builder_address.toLowerCase() === pair.data.builder_wallet.toLowerCase();
                  const at1b = builderTakeUsd(row.builder_fee_tenths);
                  const isDraft = row.status === 'draft';
                  return (
                    <li key={row.id}>
                      <CreatorAppCard
                        tenant={row}
                        market={marketFor(coinMarkets.data, row.coin?.token)}
                        appEarnedUsd={ownB ? appEarnedTotal : displayEarnedUsd(row)}
                        tokenEarnedUsd={earnedFor(earnedMap.data, row.coin?.token)}
                        to={isDraft ? '/create' : tenantAppHref(row.slug)}
                        layout="wide"
                        onEditFee={
                          isDraft
                            ? undefined
                            : () => {
                                setFeeError(null);
                                setFeeEdit(row);
                              }
                        }
                        onEditPledge={
                          isDraft
                            ? undefined
                            : () => {
                                setPledgeError(null);
                                setPledgeEdit({ tenant: row, kind: 'buyback' });
                              }
                        }
                        onEditBurn={
                          isDraft
                            ? undefined
                            : () => {
                                setPledgeError(null);
                                setPledgeEdit({ tenant: row, kind: 'burn' });
                              }
                        }
                        onEditBuyback={
                          isDraft || !row.coin || isExternalCoin(row.coin)
                            ? undefined
                            : () => {
                                setBuybackEdit(row);
                              }
                        }
                        badge={
                          isDraft ? (
                            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-extrabold text-warning">
                              draft
                            </span>
                          ) : ownB ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="tag-ok">
                                <IconCheck size={9} /> Live
                              </span>
                              <CustomDomainBadge tenant={row} />
                            </span>
                          ) : (
                            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-extrabold text-warning">
                              preview
                            </span>
                          )
                        }
                        trailing={
                          isDraft ? (
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                className="btn-ghost btn-sm px-3 py-1.5 text-xs"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDiscardError(null);
                                  setDiscard(row);
                                }}
                              >
                                Discard
                              </button>
                              <span className="btn-primary btn-sm shrink-0 px-3 py-1.5 text-xs">Resume</span>
                            </div>
                          ) : (
                            <div className="shrink-0 text-right">
                              <div className="text-[15px] font-black tabular text-brand">{formatCompactUsd(at1b)}</div>
                              <div className="text-[10px] font-bold text-fg-subtle">
                                at {formatCompactUsd(PREVIEW_NOTIONAL_USD)} vol
                              </div>
                            </div>
                          )
                        }
                        footer={
                          isDraft ? null : (
                            <>
                              <StreamDeskCard tenant={row} />
                              {ownB ? (
                                <HlFeesCard
                                  builder={row.builder_address}
                                  lifetimeUsd={appEarnedTotal}
                                />
                              ) : null}
                              {row.coin ? (
                                isExternalCoin(row.coin) ? null : <CoinFeesCard coin={row.coin} />
                              ) : row.status === 'live' ? (
                                <LaunchCoinLater
                                  tenant={row}
                                  onDone={() => void qc.invalidateQueries({ queryKey: ['my-tenants'] })}
                                />
                              ) : null}
                            </>
                          )
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      {discard ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
          onClick={() => {
            if (!discardBusy) setDiscard(null);
          }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-labelledby="discard-draft-title"
            className="card-pop w-full max-w-sm p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="discard-draft-title" className="text-[15px] font-extrabold">
              Discard this draft?
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-fg-muted">
              The unpublished app and its handle go away. Connected socials stay on your login. You
              can start again.
            </p>
            {discardError ? (
              <p className="mt-2 text-[12px] font-semibold text-error">{discardError}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost px-4 py-2 text-sm"
                disabled={discardBusy}
                onClick={() => setDiscard(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-sm"
                disabled={discardBusy}
                onClick={async () => {
                  setDiscardBusy(true);
                  setDiscardError(null);
                  try {
                    const token = await getAccessToken();
                    if (!token) throw new Error('Sign in again');
                    await deleteTenantDraft(discard.slug, token);
                    try {
                      sessionStorage.removeItem('bp-launch-draft');
                    } catch {
                      /* private mode */
                    }
                    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
                    setDiscard(null);
                  } catch (e) {
                    setDiscardError(e instanceof Error ? e.message : 'Could not discard');
                  } finally {
                    setDiscardBusy(false);
                  }
                }}
              >
                {discardBusy ? 'Discarding…' : 'Discard'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {feeEdit ? (
        <BuilderFeeEditDialog
          tenths={feeEdit.builder_fee_tenths}
          history={feeEdit.builder_fee_history}
          busy={feeBusy}
          error={feeError}
          onClose={() => {
            if (!feeBusy) setFeeEdit(null);
          }}
          onSave={async (tenths) => {
            setFeeBusy(true);
            setFeeError(null);
            try {
              const token = await getAccessToken();
              if (!token) throw new Error('Sign in again');
              await patchTenant(feeEdit.slug, { builder_fee_tenths: tenths }, token);
              void qc.invalidateQueries({ queryKey: ['my-tenants'] });
              void qc.invalidateQueries({ queryKey: ['tenants', 'directory'] });
              void qc.invalidateQueries({ queryKey: ['tenant', feeEdit.slug] });
              setFeeEdit(null);
            } catch (e) {
              setFeeError(e instanceof Error ? e.message : 'Could not save fee');
            } finally {
              setFeeBusy(false);
            }
          }}
        />
      ) : null}
      {pledgeEdit ? (
        <PledgeEditDialog
          kind={pledgeEdit.kind}
          pct={
            pledgeEdit.kind === 'burn'
              ? (pledgeEdit.tenant.burn_pct ?? 0)
              : (pledgeEdit.tenant.buyback_pct ?? 0)
          }
          history={
            pledgeEdit.kind === 'burn'
              ? pledgeEdit.tenant.burn_history
              : pledgeEdit.tenant.buyback_history
          }
          buybackPct={pledgeEdit.tenant.buyback_pct ?? 0}
          busy={pledgeBusy}
          error={pledgeError}
          onClose={() => {
            if (!pledgeBusy) setPledgeEdit(null);
          }}
          onSave={async (pct) => {
            setPledgeBusy(true);
            setPledgeError(null);
            try {
              const token = await getAccessToken();
              if (!token) throw new Error('Sign in again');
              const body =
                pledgeEdit.kind === 'burn' ? { burn_pct: pct } : { buyback_pct: pct };
              await patchTenant(pledgeEdit.tenant.slug, body, token);
              void qc.invalidateQueries({ queryKey: ['my-tenants'] });
              void qc.invalidateQueries({ queryKey: ['tenants', 'directory'] });
              void qc.invalidateQueries({ queryKey: ['tenant', pledgeEdit.tenant.slug] });
              setPledgeEdit(null);
            } catch (e) {
              setPledgeError(e instanceof Error ? e.message : 'Could not save pledge');
            } finally {
              setPledgeBusy(false);
            }
          }}
        />
      ) : null}
      {buybackEdit ? (
        <TokenBuybackEditDialog tenant={buybackEdit} onClose={() => setBuybackEdit(null)} />
      ) : null}
    </div>
  );
}
