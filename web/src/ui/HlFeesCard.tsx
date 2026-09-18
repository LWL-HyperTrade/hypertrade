import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebAuth } from '../lib/auth';
import { formatCompactUsd } from '../lib/earnings';
import {
  claimHlRewards,
  fetchHlRewards,
  HL_CLAIM_MIN_USD,
  isWalletUserRejectedRequest,
  type Hex,
} from '../lib/hlTrade';
import { IconChart } from './icons';

/**
 * Hyperliquid perp builder fees. Claim is the official `claimRewards`
 * L1 action (same path as referrals). Signed by HD 1. Lands in spot USDC.
 */
export function HlFeesCard({
  builder,
  lifetimeUsd,
}: {
  builder: string;
  lifetimeUsd: number;
}) {
  const { getBuilderEthereumProvider } = useWebAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const rewards = useQuery({
    queryKey: ['hl-referral', builder.toLowerCase()],
    enabled: !!builder,
    queryFn: () => fetchHlRewards(builder as Hex),
    refetchInterval: 30_000,
  });

  const unclaimed = rewards.data?.unclaimed ?? 0;
  const lifetime = rewards.data?.builder || lifetimeUsd;
  const canClaim = unclaimed >= HL_CLAIM_MIN_USD;

  const claim = async () => {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const provider = await getBuilderEthereumProvider(builder);
      if (!provider) throw new Error('Builder wallet is not ready');
      await claimHlRewards({ builder: builder as Hex, provider });
      setOk('Claimed to your builder spot USDC on Hyperliquid.');
      void qc.invalidateQueries({ queryKey: ['hl-referral'] });
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected.');
      else setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5">
      <div className="min-w-0 text-[12px] text-fg-subtle">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-flex text-brand"
            title="Hyperliquid perps"
            aria-label="Hyperliquid perps"
          >
            <IconChart size={12} />
          </span>
          <span className="rounded-full bg-fill-weak px-2 py-0.5 text-[10px] font-extrabold uppercase text-fg-muted">
            builder
          </span>
        </div>
        <div className="mt-0.5 tabular">
          {rewards.isError ? (
            <span className="text-error">Could not read builder rewards</span>
          ) : (
            <>
              lifetime <span className="font-bold text-fg">{formatCompactUsd(lifetime)}</span>
              {' '}
              · claimable{' '}
              <span className="font-bold text-success">{formatUsdFine(unclaimed)}</span>
              {' '}
              {!canClaim && unclaimed > 0 ? (
                <> · needs ${HL_CLAIM_MIN_USD}+ to pay out</>
              ) : null}
            </>
          )}
        </div>
        {ok ? <div className="text-[11px] font-semibold text-brand">{ok}</div> : null}
        {error ? <div className="text-[11px] font-semibold text-error">{error}</div> : null}
      </div>
      <button
        type="button"
        className="btn-primary btn-sm shrink-0 px-3 py-1.5 text-xs"
        disabled={busy || rewards.isLoading || !canClaim}
        onClick={() => void claim()}
      >
        {busy ? 'Claiming…' : 'Claim app fees'}
      </button>
    </div>
  );
}

function formatUsdFine(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
