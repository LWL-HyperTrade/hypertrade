import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { useWebAuth, type SocialProvider } from '../lib/auth';
import { createTenant, fetchCatalogAssets, listMyTenants, patchTenant } from '../lib/api';
import { PREVIEW_NOTIONAL_USD, PONS_DESCRIPTION_MAX, PONS_NAME_MAX, PONS_SYMBOL_MAX, formatPledgePercent, keepPct, slugFromName, suggestedTokenSymbol } from '../lib/earnings';
import { canLaunch, type CoinDraft } from '../lib/pons';
import {
  normalizeTenantSlug,
  normalizeWebsiteUrl,
  slugError,
  websiteError,
  type TenantPublic,
  type WizardDraft,
} from '../lib/tenants';
import { TENANT_DEFAULT_FEE_TENTHS, TENANT_MAX_CATALOG, goToTenantApp, tenantPublicUrl } from '../lib/config';
import { isImportedBuilderRejected, useEnsureBuilderWallets } from '../lib/useEnsureBuilderWallets';
import { BuilderActivateCard, BuilderProvisionFallback } from './BuilderActivateCard';
import { CoinLaunch } from './CoinLaunch';
import {
  CoinTermsFields,
  EMPTY_COIN_TERMS,
  parseTeamWallets,
  quoteSymbolFor,
  useLaunchFunding,
  usePonsQuotes,
  type CoinTerms,
} from './CoinTermsFields';
import { EarningsHero } from './EarningsHero';
import { PledgeChipRow } from './AppPledge';
import { LaunchPreview } from './LaunchPreview';
import { LaunchSuccessModal } from './LaunchSuccessModal';
import { LogoField } from './LogoField';
import { SocialConnect } from './SocialConnect';
import { BuilderActivateSkeleton } from './skeleton';
import { IconArrow, IconChart, IconCheck, IconCoin, IconLock, IconRocket, IconWallet } from './icons';

const SHOW_ALL: Record<SocialProvider, boolean> = {
  twitter: true,
  telegram: true,
  discord: true,
  tiktok: true,
  instagram: true,
  youtube: true,
  twitch: true,
};

const CHAPTERS = [
  { label: 'App', Icon: IconRocket },
  { label: 'Activate', Icon: IconWallet },
  { label: 'Token', Icon: IconCoin },
] as const;
const DRAFT_KEY = 'bp-launch-draft';
type Draft = {
  chapter: number;
  appName: string;
  slug: string;
  slugTouched: boolean;
  description: string;
  logoUrl: string;
  website: string;
  show: Record<SocialProvider, boolean>;
  feeTenths: number;
  buybackPct: number;
  burnPct: number;
  notional: number;
  coin: CoinTerms;
};
const EMPTY: Draft = {
  chapter: 0,
  appName: '',
  slug: '',
  slugTouched: false,
  description: '',
  logoUrl: '',
  website: '',
  show: SHOW_ALL,
  feeTenths: TENANT_DEFAULT_FEE_TENTHS,
  buybackPct: 0,
  burnPct: 0,
  notional: PREVIEW_NOTIONAL_USD,
  coin: EMPTY_COIN_TERMS,
};

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      ...EMPTY,
      ...parsed,
      show: { ...EMPTY.show, ...parsed.show },
      coin: { ...EMPTY_COIN_TERMS, ...(parsed.coin ?? {}) },
    };
  } catch {
    return EMPTY;
  }
}

function clearDraftStorage() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* private mode */
  }
}

function isEmptyDraft(d: Draft): boolean {
  return (
    d.chapter === 0 &&
    !d.appName.trim() &&
    !d.slug.trim() &&
    !d.description.trim() &&
    !d.logoUrl.trim() &&
    !d.website.trim() &&
    !d.coin.symbol.trim() &&
    !d.coin.devBuy.trim()
  );
}

/** App is live and the Pons token is on the row — wizard should not resume this launch. */
function isAppAndTokenDone(t: TenantPublic): boolean {
  return t.status === 'live' && !!t.coin?.token;
}

function wizardBlob(d: Draft): WizardDraft {
  return { chapter: d.chapter, notional: d.notional, show: d.show, coin: d.coin };
}

function draftFromTenant(row: TenantPublic): Draft {
  const w = row.wizard_draft ?? {};
  const show = { ...EMPTY.show, ...(w.show ?? {}) };
  const chapter = w.chapter === 0 || w.chapter === 1 || w.chapter === 2 ? w.chapter : 1;
  return {
    chapter,
    appName: row.app_name || '',
    slug: row.slug || '',
    slugTouched: true,
    description: row.description || '',
    logoUrl: row.logo_url || '',
    website: row.socials?.website || '',
    show,
    feeTenths: row.builder_fee_tenths,
    buybackPct: row.buyback_pct ?? 0,
    burnPct: row.burn_pct ?? 0,
    notional: w.notional ?? EMPTY.notional,
    coin: { ...EMPTY_COIN_TERMS, ...(w.coin ?? {}) },
  };
}

export function CreatePage() {
  const { authenticated, getAccessToken, address, login, socials, linkSocial, unlinkSocial, linkError } = useWebAuth();
  const pair = useEnsureBuilderWallets();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [d, setD] = useState<Draft>(loadDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState<string[] | null>(null);
  /** Set once the app row exists; the token launch then runs against it. */
  const [published, setPublished] = useState<{ tenant: TenantPublic; coin: CoinDraft | null } | null>(null);
  /** Success sheet after publish (app only) or after the token confirms. */
  const [success, setSuccess] = useState<{ tenant: TenantPublic; tokenLaunched: boolean } | null>(null);
  const [draftSlug, setDraftSlug] = useState<string | null>(null);
  const hydrated = useRef(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const quotes = usePonsQuotes();
  const mine = useQuery({
    queryKey: ['my-tenants'],
    enabled: authenticated,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listMyTenants(token);
    },
  });
  const gate = useQuery({
    queryKey: ['pons-can-launch', address],
    enabled: !!address,
    queryFn: () => canLaunch(address as Address),
    staleTime: 60_000,
  });
  const launchOpen = gate.data === true;

  useEffect(() => {
    if (!mine.data || hydrated.current) return;
    hydrated.current = true;

    // Resume an unfinished app draft from the server.
    const row = mine.data.find((t) => t.status === 'draft');
    if (row) {
      setDraftSlug(row.slug);
      setD(draftFromTenant(row));
      return;
    }

    // Drop a leftover browser draft only when that app is live *and* has a token.
    // Keep local state if the app is still a draft, or live without a coin yet.
    const localSlug = normalizeTenantSlug(d.slug);
    if (
      localSlug &&
      mine.data.some((t) => t.slug === localSlug && isAppAndTokenDone(t))
    ) {
      clearDraftStorage();
      setD(EMPTY);
      setDraftSlug(null);
      setPublished(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once when mine arrives
  }, [mine.data]);

  useEffect(() => {
    try {
      if (isEmptyDraft(d)) {
        sessionStorage.removeItem(DRAFT_KEY);
        return;
      }
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* private mode */
    }
  }, [d]);

  useEffect(() => {
    if (d.chapter !== 2 || !draftSlug) return;
    const id = window.setTimeout(() => {
      void persistDraft(2).catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.chapter, d.coin, draftSlug]);

  const markets = useQuery({ queryKey: ['catalog'], queryFn: fetchCatalogAssets, staleTime: 60_000 });
  // Same symbol rules as backend normalize_catalog, so one odd ticker can't block publish.
  const universe = useMemo(
    () =>
      (markets.data ?? [])
        .filter((a) => /^[A-Za-z0-9]{2,20}$|^[a-z0-9]{1,16}:[A-Za-z0-9]{2,20}$/.test(a.coin))
        .slice(0, TENANT_MAX_CATALOG),
    [markets.data],
  );
  const slugNorm = normalizeTenantSlug(d.slug);
  const slugErr = d.slug ? slugError(d.slug) : 'Pick a handle';
  const liveOwn = pair.data?.live === 'own';
  const collectingOk =
    liveOwn && !!pair.data?.hl?.ready && !!pair.data?.hl?.standard;
  const platformBuilder = (pair.data?.platform_builder || '').toLowerCase();
  const previewLiveCount = (mine.data ?? []).filter((t) => {
    if (t.status !== 'live') return false;
    if (!platformBuilder) return false;
    return t.builder_address.toLowerCase() === platformBuilder;
  }).length;
  const previewCapped = !liveOwn && previewLiveCount >= 1;
  const tokenSymbol = (d.coin.symbol || suggestedTokenSymbol(d.appName)).toUpperCase().slice(0, PONS_SYMBOL_MAX);
  const quoteLabel = quoteSymbolFor(quotes.data, d.coin.pairToken);
  // Mute "Publish + launch token" until the trade wallet can pay fee + gas (+ dev buy).
  const funding = useLaunchFunding(d.coin, address ?? null, quoteLabel);
  const fundingBlocks = d.chapter === 2 && launchOpen && funding.ready === false;
  const fundingChecking = d.chapter === 2 && launchOpen && funding.ready === null && !!address;
  // Privy's embedded wallet can resolve a beat after `authenticated`. Nothing is
  // saved without it — the row would have no owner wallet and the coin attach fails.
  const walletPending = authenticated && !address;

  // After publish the token launcher replaces the form — bring it into view instead of
  // leaving the user parked at the bottom of the old form.
  const launchPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!published) return;
    const el = launchPanelRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [published]);

  const missingApp = useMemo(() => {
    const miss: string[] = [];
    if (d.appName.trim().length < 2) miss.push('Name');
    if (slugErr) miss.push(d.slug ? `Handle (${slugErr})` : 'Handle');
    if (!d.logoUrl.trim()) miss.push('Logo');
    if (universe.length === 0) miss.push(markets.isLoading ? 'Markets (still loading)' : 'Markets');
    return miss;
  }, [d.appName, d.slug, d.logoUrl, slugErr, universe.length, markets.isLoading]);
  const appReady = missingApp.length === 0;

  useEffect(() => {
    if (appReady) setNudge(null);
  }, [appReady]);

  const skipToToken = () => {
    setBusy(true);
    setError(null);
    void persistDraft(2)
      .then(() => set('chapter', 2))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not save draft'))
      .finally(() => setBusy(false));
  };

  const onName = (v: string) => {
    const name = v.slice(0, PONS_NAME_MAX);
    setD((p) => ({ ...p, appName: name, slug: p.slugTouched ? p.slug : slugFromName(name) }));
  };

  const safeWebsite = (): string => {
    const err = websiteError(d.website);
    if (err) throw new Error(err);
    return normalizeWebsiteUrl(d.website);
  };

  const coinDraftFor = (): CoinDraft => ({
    name: d.appName.trim(),
    symbol: tokenSymbol,
    logo: d.logoUrl.trim(),
    description: d.description.trim(),
    // Pons `Socials` struct: twitter, telegram, discord, website, farcaster only.
    socials: {
      twitter: d.show.twitter ? socials.twitter : '',
      telegram: d.show.telegram ? socials.telegram : '',
      discord: d.show.discord ? socials.discord : '',
      website: safeWebsite(),
      farcaster: '',
    },
    pairToken: d.coin.pairToken as Address,
    devBuy: d.coin.devBuy.trim(),
    creatorTaxBps: d.coin.creatorTaxBps,
    buybackEnabled: d.coin.buybackEnabled,
    creatorFeeRecipient: d.coin.creatorFeeRecipient.trim(),
    snipeTaxExemptions: parseTeamWallets(d.coin.teamWallets).valid,
  });

  // Clear local wizard only after a full app + token launch. App-only publish
  // (or live-without-coin) keeps the form so LaunchCoinLater / retry still has context.
  const resetWizardIf = (clear: boolean) => {
    if (!clear) return;
    clearDraftStorage();
    setD(EMPTY);
    setDraftSlug(null);
    setPublished(null);
    setError(null);
    setNudge(null);
  };

  const finish = (slug: string, opts?: { clearWizard?: boolean }) => {
    resetWizardIf(!!opts?.clearWizard);
    goToTenantApp(slug, navigate);
  };

  const celebrate = (tenant: TenantPublic, tokenLaunched: boolean) => {
    setSuccess({ tenant, tokenLaunched });
  };

  const identityPayload = () => ({
    app_name: d.appName.trim(),
    slug: slugNorm,
    description: d.description.trim(),
    logo_url: d.logoUrl.trim(),
    socials: {
      twitter: d.show.twitter ? socials.twitter : '',
      telegram: d.show.telegram ? socials.telegram : '',
      discord: d.show.discord ? socials.discord : '',
      tiktok: d.show.tiktok ? socials.tiktok : '',
      instagram: d.show.instagram ? socials.instagram : '',
      youtube: d.show.youtube ? socials.youtube : '',
      twitch: d.show.twitch ? socials.twitch : '',
      website: safeWebsite(),
    },
    catalog: universe.map((a) => a.coin),
    builder_fee_tenths: d.feeTenths,
    buyback_pct: d.buybackPct,
    burn_pct: d.burnPct,
    owner_wallet: address,
  });

  const WALLET_NOT_READY =
    'Your trade wallet is still loading — give it a second and retry. Publishing without it would leave the app with no owner wallet.';

  const persistDraft = async (chapter: number) => {
    if (!address) throw new Error(WALLET_NOT_READY);
    const token = await getAccessToken();
    if (!token) throw new Error('Could not get a session token. Sign in again.');
    const tenant = await createTenant(
      {
        ...identityPayload(),
        status: 'draft',
        wizard_draft: wizardBlob({ ...d, chapter }),
      },
      token,
    );
    setDraftSlug(tenant.slug);
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    return tenant;
  };

  const publish = async (withCoin: boolean) => {
    setError(null);
    if (!authenticated) {
      login();
      return;
    }
    const siteErr = websiteError(d.website);
    if (siteErr) {
      setError(siteErr);
      set('chapter', 0);
      return;
    }
    if (previewCapped) {
      setError(
        'Max one live preview app. Activate to launch another with your own builder fee.',
      );
      set('chapter', 1);
      return;
    }
    if (!address) {
      setError(WALLET_NOT_READY);
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setError('Could not get a session token. Sign in again.');
      return;
    }
    setBusy(true);
    try {
      const payload = identityPayload();
      const tenant = draftSlug
        ? await patchTenant(draftSlug, { ...payload, status: 'live', slug: slugNorm }, token)
        : await createTenant(payload, token);
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      // The app is live from here. The token is a second tx and must never undo it.
      if (withCoin && launchOpen) {
        setPublished({ tenant, coin: coinDraftFor() });
      } else {
        // App live, token skipped or gated — keep wizard in session until a coin exists.
        celebrate(tenant, false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create app');
    } finally {
      setBusy(false);
    }
  };

  if (!authenticated) {
    return (
      <div className="mx-auto max-w-md pt-10 text-center">
        <h1 className="display text-4xl">
          Launch <span className="text-hype">your app</span>
        </h1>
        <p className="mt-3 text-sm text-fg-muted">Your app and token, one identity. Sign in to start.</p>
        <button type="button" className="btn-primary mt-8 px-6 py-3 text-sm" onClick={() => login()}>
          Sign in <IconArrow size={16} />
        </button>
      </div>
    );
  }

  const goTo = (i: number) => {
    if (i === d.chapter) return;
    if (i > 0 && !appReady) {
      setNudge(missingApp);
      document.getElementById('launch-identity')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const apply = () => {
      setNudge(null);
      setError(null);
      set('chapter', i);
    };
    if (i > d.chapter) {
      setBusy(true);
      void persistDraft(i)
        .then(apply)
        .catch((e) => setError(e instanceof Error ? e.message : 'Could not save draft'))
        .finally(() => setBusy(false));
      return;
    }
    apply();
  };

  const next = () => {
    if (d.chapter === 2) {
      if (previewCapped) {
        setError(
          'Max one live preview app. Activate to launch another with your own builder fee.',
        );
        goTo(1);
        return;
      }
      void publish(true);
      return;
    }
    goTo(d.chapter + 1);
  };

  const leaveToMyApps = () => {
    if (!success) return;
    resetWizardIf(success.tokenLaunched);
    setSuccess(null);
    navigate('/apps');
  };
  const successModal = success ? (
    <LaunchSuccessModal
      tenant={success.tenant}
      tokenLaunched={success.tokenLaunched}
      onOpenApp={() => finish(success.tenant.slug, { clearWizard: success.tokenLaunched })}
      onMyApps={leaveToMyApps}
      onClose={leaveToMyApps}
    />
  ) : null;

  if (published) {
    return (
      <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="display text-4xl sm:text-5xl">
              <span className="text-hype">{published.tenant.app_name}</span> is live
            </h1>
            <p className="mt-2 text-sm text-fg-muted">
              Step 3 of {CHAPTERS.length} — Token · app is on My apps, deploying the token now
            </p>
          </div>
          <ol className="steps">
            {CHAPTERS.map(({ label }, i) => (
              <li key={label} className="contents">
                {i > 0 ? <span className="step-rail" data-done /> : null}
                <span className="step" data-state={i === 2 ? 'active' : 'done'}>
                  <span className="step-num">{i < 2 ? <IconCheck size={13} /> : i + 1}</span>
                  <span className="step-label">{label}</span>
                  <span className="step-frac">
                    {i + 1}/{CHAPTERS.length}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="mb-6 hidden lg:block" aria-hidden />

        <div ref={launchPanelRef} className="min-w-0 scroll-mt-24">
          {published.coin ? (
            <CoinLaunch
              slug={published.tenant.slug}
              draft={published.coin}
              onDone={(tenant) => celebrate(tenant, isAppAndTokenDone(tenant))}
              onCancel={() => finish(published.tenant.slug, { clearWizard: false })}
              cancelLabel="Open the app"
            />
          ) : null}
        </div>

        {successModal}

        <LaunchPreview
          appName={published.tenant.app_name}
          slug={published.tenant.slug}
          description={published.tenant.description}
          logoUrl={published.tenant.logo_url}
          feeTenths={published.tenant.builder_fee_tenths}
          buybackPct={published.tenant.buyback_pct ?? d.buybackPct}
          burnPct={published.tenant.burn_pct ?? d.burnPct}
          notional={d.notional}
          markets={universe}
          liveOwn={liveOwn}
          tokenSymbol={tokenSymbol}
          quoteLabel={quoteLabel}
          chain="robinhood"
          socials={{ ...socials, website: d.website }}
          show={d.show}
          coin={d.coin}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      {successModal}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="display text-4xl sm:text-5xl">
            Launch <span className="text-hype">your app</span>
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            Step {d.chapter + 1} of {CHAPTERS.length} — {CHAPTERS[d.chapter].label}
          </p>
        </div>
        <ol className="steps">
          {CHAPTERS.map(({ label }, i) => (
            <li key={label} className="contents">
              {i > 0 ? <span className="step-rail" data-done={i <= d.chapter ? true : undefined} /> : null}
              <button
                type="button"
                className="step"
                data-state={i === d.chapter ? 'active' : i < d.chapter ? 'done' : 'todo'}
                onClick={() => goTo(i)}
              >
                <span className="step-num">{i < d.chapter ? <IconCheck size={13} /> : i + 1}</span>
                <span className="step-label">{label}</span>
                <span className="step-frac">
                  {i + 1}/{CHAPTERS.length}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="mb-6 hidden lg:block" aria-hidden />

      <div className="min-w-0">
        {d.chapter === 0 ? (
          <div className="grid gap-5">
            <EarningsHero
              feeTenths={d.feeTenths}
              onFee={(n) => set('feeTenths', n)}
              notional={d.notional}
              onNotional={(n) => set('notional', n)}
              liveOwn={liveOwn}
            />

            <section id="launch-identity" className="card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
                <IconRocket size={16} className="text-brand" /> Identity
              </h2>
              <p className="mt-1 text-[12px] text-fg-subtle">Same name for the app and the token.</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="label req">Name</span>
                  <input
                    className="field mt-1.5"
                    value={d.appName}
                    onChange={(e) => onName(e.target.value)}
                    placeholder="Alex Markets"
                    maxLength={PONS_NAME_MAX}
                    autoFocus
                    aria-invalid={d.appName.trim().length < 2 && !!nudge}
                  />
                </label>
                <label className="block">
                  <span className="label req">Handle</span>
                  <div className="field-split mt-1.5">
                    <span className="field-prefix">/t/</span>
                    <input
                      className="field"
                      value={d.slug}
                      aria-invalid={!!slugErr && (!!d.slug || !!nudge)}
                      onChange={(e) =>
                        setD((p) => ({
                          ...p,
                          slugTouched: true,
                          slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                        }))
                      }
                      placeholder="alex"
                      maxLength={32}
                    />
                  </div>
                  <span className={`mt-1 block text-[11px] leading-4 ${d.slug && slugErr ? 'text-error' : 'text-fg-subtle'}`}>
                    {d.slug && slugErr
                      ? slugErr
                      : `${tenantPublicUrl(slugNorm || 'your-app').replace(/^https?:\/\//, '')} · custom domain later`}
                  </span>
                </label>
                <label className="block sm:col-span-2">
                  <span className="label">
                    Bio <span className="opt">optional</span>
                  </span>
                  <textarea
                    className="field mt-1.5 min-h-20 resize-y"
                    value={d.description}
                    onChange={(e) => set('description', e.target.value.slice(0, PONS_DESCRIPTION_MAX))}
                    placeholder="What your app is about, in one breath"
                    maxLength={PONS_DESCRIPTION_MAX}
                  />
                </label>
                <LogoField
                  url={d.logoUrl}
                  onUrl={(v) => set('logoUrl', v)}
                  fallback={(d.appName.trim() || '?').slice(0, 1).toUpperCase()}
                  getAccessToken={getAccessToken}
                />
              </div>
            </section>

            <section className="card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
                Socials <span className="opt">optional</span>
              </h2>
              <p className="mt-1 text-[12px] text-fg-subtle">
                Connect to verify. Only accounts you actually own show on your app and token.
              </p>
              <div className="mt-4">
                <SocialConnect
                  socials={socials}
                  show={d.show}
                  onToggle={(p, on) => set('show', { ...d.show, [p]: on })}
                  onConnect={linkSocial}
                  onDisconnect={unlinkSocial}
                  website={d.website}
                  onWebsite={(v) => set('website', v)}
                  error={linkError}
                />
              </div>
            </section>

            <section className="card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold">Buybacks & burn pledge</h2>
              <p className="mt-1 text-[12px] text-fg-subtle">
                Share of your Hyperliquid builder fee you pledge to buy back, then how much of that buyback you
                burn. Promise, not on-chain.
              </p>
              <PledgeChipRow
                label="Buybacks"
                hint="of your fee"
                value={d.buybackPct}
                onPick={(n) => setD((p) => ({ ...p, buybackPct: n }))}
              />
              <PledgeChipRow
                label="Burn"
                hint="of that buyback"
                value={d.burnPct}
                onPick={(n) => setD((p) => ({ ...p, burnPct: n }))}
              />
              <p className="mt-3 text-[12px] leading-5 text-fg-subtle">
                You keep {formatPledgePercent(keepPct(d.buybackPct))} of your fee. Of the{' '}
                {formatPledgePercent(d.buybackPct)} buybacks, {formatPledgePercent(d.burnPct)} is burned.
              </p>
            </section>

            <section className="card p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
                <IconChart size={16} className="text-brand" /> Markets
              </h2>
              <p className="mt-1 text-[12px] text-fg-subtle">
                BuilderPad default list of markets. List / delist per app comes soon.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="chip" aria-pressed>
                  Markets
                </button>
                <button type="button" className="chip" data-soon disabled>
                  Predictions <span className="soon">soon</span>
                </button>
              </div>
              {markets.isError ? (
                <p className="mt-3 text-[12px] font-semibold text-error">Could not load markets — retrying.</p>
              ) : null}
            </section>
          </div>
        ) : null}

        {d.chapter === 1 ? (
          <div className="grid gap-4">
            {pair.isLoading ? (
              <BuilderActivateSkeleton />
            ) : pair.isError ? (
              isImportedBuilderRejected(pair.error) ? (
                <BuilderProvisionFallback
                  message={(pair.error as Error).message}
                  onCreate={() => pair.createNewBuilder.mutate()}
                  creating={pair.createNewBuilder.isPending}
                  createError={
                    pair.createNewBuilder.isError
                      ? (pair.createNewBuilder.error as Error).message
                      : null
                  }
                />
              ) : (
                <p className="text-sm text-fg-muted">
                  {(pair.error as Error).message}{' '}
                  <button type="button" className="font-bold underline" onClick={() => void pair.refetch()}>
                    Retry
                  </button>
                </p>
              )
            ) : pair.data ? (
              <BuilderActivateCard pair={pair.data} hasEarnings={false} />
            ) : null}
          </div>
        ) : null}

        {d.chapter === 2 ? (
          <div className="card grid gap-5 p-5">
            <div>
              <h2 className="flex items-center gap-2 text-[15px] font-extrabold">
                <IconCoin size={16} className="text-brand" /> Launch the token
              </h2>
              <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
                Same name, logo, bio, socials. Launch fee + optional dev buy come from your{' '}
                <strong className="text-fg">trade</strong> wallet, like any pad. Publish sends the app first, then
                the token — one go.
              </p>
            </div>

            {gate.isFetched && !launchOpen ? (
              <div className="flex items-start gap-3 rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3">
                <IconLock size={16} className="mt-0.5 shrink-0 text-warning" />
                <div className="text-[12px] leading-5 text-fg-muted">
                  <strong className="text-fg">Pons launches are whitelist-only right now.</strong> Your app still
                  publishes with these terms saved. Launch the token from My apps once Pons opens or whitelists your
                  trade wallet.
                </div>
              </div>
            ) : null}

            <CoinTermsFields
              terms={d.coin}
              onChange={(next) => set('coin', next)}
              symbolPlaceholder={suggestedTokenSymbol(d.appName)}
              hd0={address}
            />
          </div>
        ) : null}

        {error ? <p className="mt-4 text-sm font-semibold text-error">{error}</p> : null}
        {fundingBlocks ? (
          <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3 text-[12px] leading-5 text-fg-muted">
            <IconWallet size={16} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1 font-semibold text-fg">{funding.shortfall}</span>
          </div>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {d.chapter > 0 ? (
            <button type="button" className="btn-ghost px-4 py-3 text-sm" onClick={() => set('chapter', d.chapter - 1)}>
              Back
            </button>
          ) : (
            <Link to="/" className="btn-ghost px-4 py-3 text-sm">
              Cancel
            </Link>
          )}
          <div className="ml-auto flex flex-col items-end gap-2.5">
            {d.chapter === 1 && !collectingOk ? (
              <div className="skip-preview relative flex items-center gap-2">
                {busy ? null : (
                  <span className="skip-preview-hit relative">
                    <button
                      type="button"
                      className="skip-preview-mark"
                      aria-describedby="skip-preview-tip"
                      aria-label="Why skip"
                    >
                      !
                    </button>
                    <div id="skip-preview-tip" role="tooltip" className="skip-preview-tip">
                      <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-fg">
                        {liveOwn ? 'Refill later' : 'Preview mode'}
                      </div>
                      <p className="mt-1.5 text-[12px] leading-5 text-fg-muted">
                        {liveOwn
                          ? 'You can Activate later. Until then, you will not collect builder fees on this app.'
                          : 'Without Activation, the app goes live on the shared BuilderPad builder. You don’t collect builder fees.'}
                      </p>
                    </div>
                  </span>
                )}
                <button
                  type="button"
                  className="btn-primary px-5 py-3 text-sm"
                  disabled={busy || walletPending}
                  title={walletPending ? WALLET_NOT_READY : undefined}
                  onClick={skipToToken}
                >
                  {busy ? 'Saving…' : 'Skip to Token'}
                  {busy ? null : <IconArrow size={16} />}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`px-6 py-3 text-sm ${d.chapter === 2 ? 'btn-hype' : 'btn-primary'}`}
                disabled={busy || walletPending || (d.chapter === 2 && previewCapped) || fundingBlocks || fundingChecking}
                title={fundingBlocks ? funding.shortfall : walletPending ? WALLET_NOT_READY : undefined}
                onClick={next}
              >
                {busy
                  ? d.chapter === 2
                    ? 'Publishing…'
                    : 'Saving…'
                  : walletPending
                    ? 'Wallet loading…'
                  : d.chapter === 0
                    ? 'Next: Activate'
                    : d.chapter === 1
                      ? 'Next: Token'
                      : fundingChecking
                        ? 'Checking wallet…'
                        : fundingBlocks
                          ? 'Add ETH to launch'
                          : launchOpen
                            ? collectingOk
                              ? 'Publish app + launch token'
                              : 'Publish preview app + launch token'
                            : collectingOk
                              ? 'Publish app'
                              : 'Publish preview app'}
                {busy ? null : d.chapter === 2 ? <IconRocket size={16} /> : <IconArrow size={16} />}
              </button>
            )}
            {d.chapter === 2 && launchOpen ? (
              <button
                type="button"
                className="btn-ghost btn-sm inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-bold"
                disabled={busy || previewCapped || walletPending}
                onClick={() => void publish(false)}
              >
                {collectingOk ? 'Publish app without token' : 'Publish preview app without token'}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <LaunchPreview
        appName={d.appName}
        slug={slugNorm}
        description={d.description}
        logoUrl={d.logoUrl}
        feeTenths={d.feeTenths}
        buybackPct={d.buybackPct}
        burnPct={d.burnPct}
        notional={d.notional}
        markets={universe}
        liveOwn={liveOwn}
        tokenSymbol={tokenSymbol}
        quoteLabel={quoteLabel}
        chain="robinhood"
        socials={{ ...socials, website: d.website }}
        show={d.show}
        coin={d.coin}
      />
    </div>
  );
}
