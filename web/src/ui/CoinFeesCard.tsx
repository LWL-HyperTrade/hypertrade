import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits, type Address } from 'viem';
import { useWebAuth } from '../lib/auth';
import { ensureRobinhoodWallet } from '../lib/robinhoodWithdraw';
import {
  claimCreatorFees,
  getLaunchedToken,
  phaseLabel,
  readCreatorFees,
  robinhoodTokenUrl,
  robinhoodTxUrl,
} from '../lib/pons';
import { isWalletUserRejectedRequest } from '../lib/hlTrade';
import type { TenantCoin } from '../lib/tenants';
import { IconCoin } from './icons';
import { CoinFeesSkeleton } from './skeleton';

function fmt(n: bigint, decimals: number): string {
  const v = Number(formatUnits(n, decimals));
  if (v === 0) return '0';
  if (v < 0.0001) return v.toExponential(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/**
 * v2 claim card (https://docs.ponsfamily.com/v2 → Claiming fees).
 * Escrow (claimable) + unswept curve (phase 0) or hook pending (phase 2).
 * Graduation auto-advances; fees still sit until a sweep, then `claim()`.
 * HD 0 signs. Not v1 locker / V3 fee shares.
 */
export function CoinFeesCard({ coin }: { coin: TenantCoin }) {
  const { address, getEthereumProvider, switchTradeChain } = useWebAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const recipient = (coin.fee_recipient || address || '') as Address;
  const launch = useQuery({
    queryKey: ['pons-launch', coin.token],
    queryFn: () => getLaunchedToken(coin.token as Address),
    staleTime: 60_000,
  });
  const fees = useQuery({
    queryKey: ['pons-fees', coin.token, recipient],
    enabled: !!launch.data && !!recipient,
    queryFn: () => readCreatorFees(recipient, launch.data!),
    refetchInterval: 30_000,
  });

  const isRecipient = !!address && recipient.toLowerCase() === address.toLowerCase();

  const claim = async () => {
    setError(null);
    setTxHash(null);
    if (!address) return;
    setBusy(true);
    try {
      const provider = await ensureRobinhoodWallet({
        switchChain: switchTradeChain,
        getProvider: getEthereumProvider,
      });
      const hash = await claimCreatorFees({
        hd0: address as Address,
        pairToken: coin.pair_token as Address,
        provider,
        switchChain: switchTradeChain,
      });
      setTxHash(hash);
      void qc.invalidateQueries({ queryKey: ['pons-fees', coin.token] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected.');
      else setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  const f = fees.data;
  const dec = f?.quoteDecimals ?? 18;
  const sym = f?.quoteSymbol ?? 'ETH';
  const phase = launch.data ? phaseLabel(launch.data.phase) : null;

  if (fees.isLoading || launch.isLoading) {
    return <CoinFeesSkeleton />;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5">
      <div className="min-w-0 text-[12px] text-fg-subtle">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-flex text-brand"
            title="Pons token"
            aria-label="Pons token"
          >
            <IconCoin size={12} />
          </span>
          <a className="font-bold text-fg hover:text-brand" href={robinhoodTokenUrl(coin.token)} target="_blank" rel="noreferrer">
            ${coin.symbol || 'TOKEN'}
          </a>
          <span>· {sym}</span>
          {phase ? (
            <span className="rounded-full bg-fill-weak px-2 py-0.5 text-[10px] font-extrabold uppercase text-fg-muted">
              {phase}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 tabular">
          {f ? (
            <>
              claimable <span className="font-bold text-success">{fmt(f.claimable, dec)} {sym}</span>
              {f.unsweptFee + f.unsweptTax > 0n ? (
                <>
                  {' '}· on {f.unsweptVenue === 'pool' ? 'pool' : 'curve'}{' '}
                  <span className="font-bold text-fg">{fmt(f.unsweptFee + f.unsweptTax, dec)} {sym}</span>{' '}
                  
                </>
              ) : null}
              {f.unsweptToken > 0n ? (
                <>
                  {' '}· on pool{' '}
                  <span className="font-bold text-fg">
                    {fmt(f.unsweptToken, f.tokenDecimals)} ${coin.symbol || 'TOKEN'}
                  </span>
                </>
              ) : null}
            </>
          ) : fees.isError ? (
            <span className="text-error">Could not read fees</span>
          ) : null}
        </div>
        {txHash ? (
          <a className="text-[11px] text-brand underline" href={robinhoodTxUrl(txHash)} target="_blank" rel="noreferrer">
            Claimed — view tx
          </a>
        ) : null}
        {error ? <div className="text-[11px] font-semibold text-error">{error}</div> : null}
      </div>
      {isRecipient ? (
        <button
          type="button"
          className="btn-primary btn-sm shrink-0 px-3 py-1.5 text-xs"
          disabled={busy || !f || f.claimable === 0n}
          onClick={() => void claim()}
        >
          {busy ? 'Claiming…' : 'Claim token fees'}
        </button>
      ) : null}
    </div>
  );
}
