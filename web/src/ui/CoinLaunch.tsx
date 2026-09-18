import { useEffect, useRef, useState } from 'react';
import { useSendTransaction } from '@privy-io/react-auth';
import { useQueryClient } from '@tanstack/react-query';
import { type Address } from 'viem';
import { useWebAuth } from '../lib/auth';
import { ensureRobinhoodWallet } from '../lib/robinhoodWithdraw';
import { recordTenantCoin } from '../lib/api';
import { launchCoin, robinhoodTokenUrl, robinhoodTxUrl, ROBINHOOD_CHAIN_ID, type CoinDraft, type LaunchResult, type LaunchStep } from '../lib/pons';
import { isWalletUserRejectedRequest } from '../lib/hlTrade';
import type { TenantPublic } from '../lib/tenants';
import { IconCheck, IconCoin, IconRocket } from './icons';

const STEP_COPY: Record<LaunchStep, string> = {
  reading: 'Reading Pons launch terms…',
  switching: 'Switching your wallet to Robinhood Chain…',
  approving: 'Approve the quote asset in the wallet popup…',
  preparing: 'Checking the launch on Robinhood Chain…',
  sending: 'Confirm the Pons launch in the wallet popup…',
  confirming: 'Waiting for Robinhood Chain to confirm…',
  done: 'Launched',
};

/**
 * Runs `launchToken` / `launchAndBuy` from HD 0, then records the token on the
 * app. Never re-sends a launch that already confirmed — a failed record only
 * offers "Retry save".
 */
export function CoinLaunch({
  slug,
  draft,
  onDone,
  onCancel,
  cancelLabel = 'Back',
}: {
  slug: string;
  draft: CoinDraft;
  onDone: (tenant: TenantPublic) => void;
  /** Only shown after an error. Not shown while the tx is in flight. */
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const { address, switchTradeChain, getAccessToken, getEthereumProvider } = useWebAuth();
  const { sendTransaction } = useSendTransaction();
  const qc = useQueryClient();
  const [step, setStep] = useState<LaunchStep | 'saving' | 'idle'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<LaunchResult | null>(null);
  const [waited, setWaited] = useState(0);
  const started = useRef(false);
  const runId = useRef(0);

  const save = async (result: LaunchResult) => {
    setStep('saving');
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in again');
    const tenant = await recordTenantCoin(
      slug,
      {
        token: result.token,
        tx_hash: result.txHash,
        chain_id: ROBINHOOD_CHAIN_ID,
        launch_config_id: Number(result.launchConfigId),
        symbol: draft.symbol,
        dev_buy_quote: result.devBuyQuote,
        owner_wallet: address ?? undefined,
      },
      token,
    );
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    void qc.invalidateQueries({ queryKey: ['tenant', slug] });
    onDone(tenant);
  };

  const run = async () => {
    const id = ++runId.current;
    setError(null);
    setWaited(0);
    try {
      if (launched) {
        await save(launched);
        return;
      }
      setStep('reading');
      if (!address) throw new Error('Wallet is not ready');
      const provider = await ensureRobinhoodWallet({
        switchChain: switchTradeChain,
        getProvider: getEthereumProvider,
      });
      const result = await launchCoin({
        draft,
        hd0: address as Address,
        provider,
        switchChain: switchTradeChain,
        sendTx: async ({ to, data, value, gasLimit, maxFeePerGas, maxPriorityFeePerGas, title, description }) => {
          const { hash } = await sendTransaction(
            {
              to,
              data,
              from: address,
              value: value > 0n ? value.toString() : undefined,
              chainId: ROBINHOOD_CHAIN_ID,
              ...(gasLimit ? { gasLimit } : {}),
              ...(maxFeePerGas != null ? { maxFeePerGas: maxFeePerGas.toString() } : {}),
              ...(maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: maxPriorityFeePerGas.toString() } : {}),
            },
            {
              address,
              uiOptions: {
                showWalletUIs: true,
                description,
                buttonText: 'Approve',
                transactionInfo: { title, action: 'Launch token' },
              },
            },
          );
          return hash;
        },
        onStep: (s) => {
          if (id === runId.current) setStep(s);
        },
      });
      if (id !== runId.current) return;
      setLaunched(result);
      await save(result);
    } catch (e) {
      if (id !== runId.current) return;
      if (isWalletUserRejectedRequest(e)) {
        setError('Wallet request was rejected.');
        return;
      }
      setError(e instanceof Error ? e.message : 'Launch failed');
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = !error && step !== 'idle' && step !== 'done';

  useEffect(() => {
    if (!busy) {
      setWaited(0);
      return;
    }
    const t0 = Date.now();
    const tick = window.setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 500);
    const limitMs = step === 'sending' || step === 'approving' || step === 'confirming' || step === 'saving' ? 180_000 : step === 'preparing' ? 60_000 : 50_000;
    const fail = window.setTimeout(() => {
      setError(
        'Wallet or Robinhood Chain did not respond. The token was not saved on this app. Retry — if a tx already landed, check the explorer before sending another.',
      );
    }, limitMs);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(fail);
    };
  }, [busy, step]);

  return (
    <div className="card-money p-5">
      <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-brand">
        <IconCoin size={14} /> Deploying {draft.symbol || 'your token'}
      </div>
      <p className="mt-2 text-[13px] leading-5 text-fg-muted">The app is already live. This step only deploys the token on Pons.</p>

      {launched ? (
        <div className="mt-3 grid gap-1 text-[12px] text-fg-muted">
          <div className="inline-flex items-center gap-1.5 font-bold text-success">
            <IconCheck size={13} /> Token is live on Robinhood Chain.
          </div>
          <div className="font-mono text-[11px]">
            token{' '}
            <a className="text-brand underline" href={robinhoodTokenUrl(launched.token)} target="_blank" rel="noreferrer">
              {launched.token}
            </a>
          </div>
          <div className="font-mono text-[11px]">
            tx{' '}
            <a className="text-brand underline" href={robinhoodTxUrl(launched.txHash)} target="_blank" rel="noreferrer">
              {launched.txHash.slice(0, 18)}…
            </a>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="mt-3">
          <p className="inline-flex items-center gap-2 text-sm font-semibold">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand/30 border-t-brand" />
            {step === 'saving' ? 'Saving the token on your app…' : STEP_COPY[step as LaunchStep]}
          </p>
          {waited >= 8 ? (
            <p className="mt-1 text-[11px] text-fg-subtle">
              {step === 'sending' || step === 'approving'
                ? 'Look for the Privy confirm popup — it will not send until you approve.'
                : `Still waiting (${waited}s).`}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-error">{error}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" className="btn-primary btn-sm px-4 py-2 text-xs" onClick={() => void run()}>
              <IconRocket size={13} /> {launched ? 'Retry save' : 'Retry launch'}
            </button>
            {onCancel ? (
              <button type="button" className="text-xs font-bold text-fg-subtle hover:text-fg" onClick={onCancel}>
                {cancelLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
