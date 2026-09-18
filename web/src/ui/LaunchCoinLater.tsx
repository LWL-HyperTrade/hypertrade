import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { useWebAuth } from '../lib/auth';
import { suggestedTokenSymbol } from '../lib/earnings';
import { canLaunch, type CoinDraft } from '../lib/pons';
import type { TenantPublic } from '../lib/tenants';
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
import { IconCoin, IconLock, IconRocket, IconWallet } from './icons';

/**
 * "Launch token later" for an app published without one (skipped, failed, or
 * Pons was whitelist-only at the time). Same terms fields as the wizard; the
 * identity comes from the app row.
 */
export function LaunchCoinLater({ tenant, onDone }: { tenant: TenantPublic; onDone: () => void }) {
  const { address } = useWebAuth();
  const [open, setOpen] = useState(false);
  const [terms, setTerms] = useState<CoinTerms>(EMPTY_COIN_TERMS);
  const [draft, setDraft] = useState<CoinDraft | null>(null);
  const gate = useQuery({
    queryKey: ['pons-can-launch', address],
    enabled: !!address && open,
    queryFn: () => canLaunch(address as Address),
    staleTime: 60_000,
  });
  const quotes = usePonsQuotes();
  const funding = useLaunchFunding(terms, address ?? null, quoteSymbolFor(quotes.data, terms.pairToken));

  const start = () => {
    setDraft({
      name: tenant.app_name,
      symbol: (terms.symbol || suggestedTokenSymbol(tenant.app_name)).toUpperCase(),
      logo: tenant.logo_url,
      description: tenant.description,
      socials: {
        twitter: tenant.socials.twitter,
        telegram: tenant.socials.telegram,
        discord: tenant.socials.discord,
        website: tenant.socials.website,
        farcaster: '',
      },
      pairToken: terms.pairToken as Address,
      devBuy: terms.devBuy.trim(),
      creatorTaxBps: terms.creatorTaxBps,
      buybackEnabled: terms.buybackEnabled,
      creatorFeeRecipient: terms.creatorFeeRecipient.trim(),
      snipeTaxExemptions: parseTeamWallets(terms.teamWallets).valid,
    });
  };

  if (draft) {
    return (
      <div className="border-t border-stroke-weak p-4">
        <CoinLaunch slug={tenant.slug} draft={draft} onDone={onDone} onCancel={() => setDraft(null)} cancelLabel="Back" />
      </div>
    );
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-[12px] text-fg-subtle">
          <IconCoin size={12} /> No token yet.
        </div>
        <button type="button" className="btn-hype btn-sm shrink-0 px-3 py-1.5 text-xs" onClick={() => setOpen(true)}>
          <IconRocket size={12} /> Launch token
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 border-t border-stroke-weak p-4">
      {gate.isFetched && gate.data === false ? (
        <div className="flex items-start gap-3 rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3 text-[12px] leading-5 text-fg-muted">
          <IconLock size={16} className="mt-0.5 shrink-0 text-warning" />
          <span>
            <strong className="text-fg">Pons launches are whitelist-only right now.</strong> Your trade wallet is not
            on the list yet.
          </span>
        </div>
      ) : null}
      <CoinTermsFields
        terms={terms}
        onChange={setTerms}
        symbolPlaceholder={suggestedTokenSymbol(tenant.app_name)}
        hd0={address}
      />
      {funding.ready === false ? (
        <div className="flex items-start gap-3 rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3 text-[12px] leading-5 text-fg-muted">
          <IconWallet size={16} className="mt-0.5 shrink-0 text-warning" />
          <span className="font-semibold text-fg">{funding.shortfall}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-ghost btn-sm px-3 py-2 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-hype ml-auto px-5 py-2.5 text-sm"
          disabled={gate.data !== true || funding.ready !== true}
          title={funding.shortfall || undefined}
          onClick={start}
        >
          <IconRocket size={14} />{' '}
          {funding.ready === false ? 'Add ETH to launch' : funding.ready === null && address ? 'Checking wallet…' : 'Launch token'}
        </button>
      </div>
    </div>
  );
}
