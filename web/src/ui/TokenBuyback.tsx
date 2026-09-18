import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { refreshTenantCoin } from '../lib/api';
import { useWebAuth } from '../lib/auth';
import { ensureRobinhoodWallet } from '../lib/robinhoodWithdraw';
import { isWalletUserRejectedRequest } from '../lib/hlTrade';
import { ROBINHOOD_CHAIN_ID, setTokenBuybackEnabled } from '../lib/pons';
import type { TenantPublic } from '../lib/tenants';
import { IconClose, IconPencil } from './icons';

export function TokenBuybackValue({
  enabled,
  onEdit,
}: {
  enabled: boolean;
  onEdit?: () => void;
}) {
  return (
    <span className="inline-flex items-center justify-center gap-1">
      <span>{enabled ? 'Yes' : 'No'}</span>
      {onEdit ? (
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
          aria-label="Edit token buyback"
          title="Change buyback on-chain"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit();
          }}
        >
          <IconPencil size={11} />
        </button>
      ) : null}
    </span>
  );
}

export function TokenBuybackEditDialog({
  tenant,
  onClose,
}: {
  tenant: TenantPublic;
  onClose: () => void;
}) {
  const coin = tenant.coin;
  const { address, getAccessToken, getEthereumProvider, switchTradeChain } = useWebAuth();
  const qc = useQueryClient();
  const [next, setNext] = useState(!!coin?.buyback_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  if (!coin) return null;

  const recipient = (coin.fee_recipient || '').toLowerCase();
  const signer = (address || '').toLowerCase();
  const isRecipient = !!signer && !!recipient && signer === recipient;

  const save = async () => {
    setError(null);
    if (!address) {
      setError('Sign in with the trade wallet.');
      return;
    }
    if (!isRecipient) {
      setError('Sign from the fee recipient wallet (the trade wallet, unless you moved fees).');
      return;
    }
    setBusy(true);
    try {
      const provider = await ensureRobinhoodWallet({
        switchChain: switchTradeChain,
        getProvider: getEthereumProvider,
      });
      await setTokenBuybackEnabled({
        hd0: address as Address,
        token: coin.token as Address,
        enabled: next,
        provider,
        switchChain: switchTradeChain,
      });
      const token = await getAccessToken();
      if (token) await refreshTenantCoin(tenant.slug, token);
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      void qc.invalidateQueries({ queryKey: ['tenants', 'directory'] });
      void qc.invalidateQueries({ queryKey: ['tenant', tenant.slug] });
      void qc.invalidateQueries({ queryKey: ['pons-launch', coin.token] });
      onClose();
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected.');
      else setError(e instanceof Error ? e.message : 'Could not change buyback');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-sunken/70 px-3 pb-6 sm:items-center sm:p-6"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-labelledby="token-buyback-title"
        className="card-pop w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="token-buyback-title" className="text-[15px] font-extrabold">
            Token buyback
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
        <p className="mt-3 text-[13px] leading-5 text-fg-muted">
          On-chain with Pons. A slice of the token&apos;s trade fee buys the token back for holders.
          Needs a little ETH gas on Robinhood Chain (chain {ROBINHOOD_CHAIN_ID}).
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="chip" aria-pressed={next} onClick={() => setNext(true)}>
            Yes
          </button>
          <button type="button" className="chip" aria-pressed={!next} onClick={() => setNext(false)}>
            No
          </button>
        </div>
        {error ? <p className="mt-3 text-[12px] font-semibold text-error">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            disabled={busy || next === !!coin.buyback_enabled}
            onClick={() => void save()}
          >
            {busy ? 'Confirming…' : 'Save on-chain'}
          </button>
        </div>
      </div>
    </div>
  );
}
