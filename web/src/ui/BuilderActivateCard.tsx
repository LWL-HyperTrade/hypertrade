import { useEffect, useState } from 'react';
import { usePrivy, useSignTypedData } from '@privy-io/react-auth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateBuilderWallets,
  fetchRelayerAddress,
  syncBuilderWallets,
  type UsdcPermitBody,
} from '../lib/api';
import {
  ARBITRUM_CHAIN_ID,
  buildUsdcPermit,
  fetchArbUsdc,
  HL_BRIDGE2,
  MIN_BRIDGE2_USDC,
  readUsdcNonce,
  signUsdcPermitWithProvider,
} from '../lib/arbUsdc';
import { useWebAuth } from '../lib/auth';
import { formatUsd } from '../lib/hlMarket';
import { isWalletUserRejectedRequest, type Hex } from '../lib/hlTrade';
import { shortAddr, type BuilderWallets } from '../lib/tenants';
import { IconCash, IconCheck, IconCopy, IconLock, IconWallet } from './icons';
import { InlineSkel } from './skeleton';
import arbIcon from '../assets/images/arb-icon.webp';
import usdcIcon from '../assets/images/usdc-icon.webp';

type Phase =
  | 'idle'
  | 'switching'
  | 'sign_fee'
  | 'sign_deposit'
  | 'paying'
  | 'depositing'
  | 'waiting_hl'
  | 'activating';

function remainingToActivate(pair: BuilderWallets): number {
  const need = pair.activation_usdc ?? 100;
  const have = pair.hl?.perp_equity_usd ?? 0;
  return Math.max(0, need - have);
}

function feeUsdc(pair: BuilderWallets): number {
  return pair.activation_fee_usdc ?? 5;
}

function depositAmount(pair: BuilderWallets): number {
  const remaining = remainingToActivate(pair);
  if (remaining <= 0) return 0;
  return Math.max(MIN_BRIDGE2_USDC, remaining);
}

export function BuilderActivateCard({
  pair,
  hasEarnings = false,
}: {
  pair: BuilderWallets;
  hasEarnings?: boolean;
}) {
  const { getAccessToken, getBuilderEthereumProvider, switchBuilderChain } = useWebAuth();
  const { signTypedData } = useSignTypedData();
  const { exportWallet } = usePrivy();
  const qc = useQueryClient();
  const builder = pair.builder_wallet as Hex;
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const arbQ = useQuery({
    queryKey: ['arb-usdc', builder],
    queryFn: () => fetchArbUsdc(builder),
    refetchInterval: 15_000,
  });

  const remaining = remainingToActivate(pair);
  const need = pair.activation_usdc ?? 100;
  const fee = feeUsdc(pair);
  const feePaid = !!pair.activation_fee_paid;
  const parked = Math.min(need, Math.max(0, pair.hl?.perp_equity_usd ?? 0));
  const progress = need > 0 ? Math.min(1, parked / need) : 0;
  const available = arbQ.data?.formatted ?? null;
  const imported = pair.source === 'imported';
  const ready = !!pair.hl?.ready && !!pair.hl?.standard;
  const liveOwn = pair.live === 'own';
  const fundedMet = remaining <= 0;
  const depositUsd = depositAmount(pair);
  const arbNeed = (feePaid ? 0 : fee) + depositUsd;
  const collectingOk = liveOwn && ready;
  const unifyBlocked = liveOwn && fundedMet && !pair.hl?.standard;
  const collecting = collectingOk && hasEarnings;
  const busy = phase !== 'idle' && phase !== 'waiting_hl';

  const applyWallets = (wallets: BuilderWallets) => {
    qc.setQueriesData({ queryKey: ['builder-wallets'] }, wallets);
    void qc.invalidateQueries({ queryKey: ['my-tenants'] });
    void qc.invalidateQueries({ queryKey: ['tenant'] });
    void qc.invalidateQueries({ queryKey: ['arb-usdc', builder] });
  };

  const sync = useMutation({
    mutationFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return syncBuilderWallets(token);
    },
    onSuccess: applyWallets,
  });

  useEffect(() => {
    if (liveOwn && !ready && phase === 'idle') setOk(null);
  }, [liveOwn, ready, phase]);

  useEffect(() => {
    if (phase !== 'waiting_hl') return;
    if (ready) {
      setPhase('idle');
      setOk('Revenue is on.');
      sync.mutate();
      return;
    }
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      if (n > 18) {
        window.clearInterval(id);
        setPhase('idle');
        setOk('If the 100 USDC is on Hyperliquid, hit Activate again. Deposit credit can take a minute.');
        return;
      }
      sync.mutate();
    }, 5_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ready]);

  const assertBuilderSigner = async () => {
    const provider = await getBuilderEthereumProvider(builder);
    if (!provider) {
      throw new Error(
        imported
          ? 'Connect the builder wallet in MetaMask (the one on the QR), then retry.'
          : 'Builder wallet is not ready. Refresh and try again.',
      );
    }
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
      params: [],
    })) as string[];
    const signer = (accounts?.[0] || '').toLowerCase();
    if (!signer || signer !== builder.toLowerCase()) {
      throw new Error(
        imported
          ? 'Wrong MetaMask account — switch to the builder address above.'
          : 'Wrong wallet — activation aborted',
      );
    }
    return provider;
  };

  const signPermit = async (args: {
    provider: Awaited<ReturnType<typeof getBuilderEthereumProvider>>;
    spender: Hex;
    amountUsdc: string;
    nonce: bigint;
    title: string;
    description: string;
  }): Promise<UsdcPermitBody> => {
    const { typedData, permit } = await buildUsdcPermit({
      owner: builder,
      spender: args.spender,
      amountUsdc: args.amountUsdc,
      nonce: args.nonce,
    });
    try {
      const { signature } = await signTypedData(typedData as unknown as Parameters<typeof signTypedData>[0], {
        address: builder,
        uiOptions: {
          showWalletUIs: true,
          title: args.title,
          description: args.description,
        },
      });
      return { ...permit, signature };
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) throw e;
      if (!args.provider) throw e;
      const signed = await signUsdcPermitWithProvider({
        provider: args.provider,
        owner: builder,
        spender: args.spender,
        amountUsdc: args.amountUsdc,
        nonce: args.nonce,
      });
      return signed;
    }
  };

  const activate = async () => {
    setError(null);
    setOk(null);
    const needFee = !feePaid;
    const needDeposit = depositUsd > 0;
    if (!needFee && !needDeposit && ready) {
      setPhase('activating');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Sign in again');
        applyWallets(await syncBuilderWallets(token));
        setOk('Revenue is on.');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not activate');
      } finally {
        setPhase('idle');
      }
      return;
    }
    const walletUsd = arbQ.data?.formatted;
    if (arbNeed > 0 && walletUsd != null && arbNeed > walletUsd + 1e-9) {
      setError(`Need ${arbNeed.toFixed(0)} USDC on Arbitrum in this builder wallet.`);
      return;
    }
    setPhase('switching');
    try {
      await switchBuilderChain(ARBITRUM_CHAIN_ID, builder);
      const provider = await assertBuilderSigner();
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');

      let nonce = await readUsdcNonce(builder);
      const totalSigs = Number(needFee) + Number(needDeposit);
      let sigN = 0;

      let feePermit: UsdcPermitBody | undefined;
      let depositPermit: UsdcPermitBody | undefined;

      if (needFee) {
        sigN += 1;
        setPhase('sign_fee');
        feePermit = await signPermit({
          provider,
          spender: (await fetchRelayerAddress(builder)) as Hex,
          amountUsdc: String(fee),
          nonce,
          title: totalSigs > 1 ? `BuilderPad fee · ${sigN} of ${totalSigs}` : 'BuilderPad fee',
          description: `Approve ${fee} USDC. Gasless — we submit it. This fee is not refunded. Rejecting here charges nothing.`,
        });
        nonce += 1n;
      }
      if (needDeposit) {
        sigN += 1;
        setPhase('sign_deposit');
        depositPermit = await signPermit({
          provider,
          spender: HL_BRIDGE2,
          amountUsdc: depositUsd.toFixed(6).replace(/\.?0+$/, ''),
          nonce,
          title: totalSigs > 1 ? `Hyperliquid deposit · ${sigN} of ${totalSigs}` : 'Hyperliquid deposit',
          description: `Approve ${depositUsd.toFixed(0)} USDC into Hyperliquid. This 100 stays in your builder and is refundable. Rejecting here charges nothing.`,
        });
      }

      if (needFee) setPhase('paying');
      else if (needDeposit) setPhase('depositing');
      const wallets = await activateBuilderWallets(
        { fee: feePermit, deposit: depositPermit },
        token,
      );
      applyWallets(wallets);
      if (wallets.hl?.ready) {
        setOk('Revenue is on.');
        setPhase('idle');
        return;
      }
      if (needDeposit) {
        setPhase('waiting_hl');
        setOk(
          liveOwn
            ? 'Waiting for Hyperliquid to credit the 100 USDC.'
            : 'Fee received. Waiting for Hyperliquid to credit the 100 USDC, then revenue turns on.',
        );
        return;
      }
      setPhase('activating');
      applyWallets(await syncBuilderWallets(token));
      setOk('Done.');
      setPhase('idle');
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected. Nothing was charged.');
      else setError(e instanceof Error ? e.message : 'Activate failed');
      setPhase('idle');
    }
  };

  const phaseLabel =
    phase === 'switching'
      ? imported
        ? 'Switch MetaMask to Arbitrum…'
        : 'Switching to Arbitrum…'
      : phase === 'sign_fee'
        ? 'Sign the BuilderPad fee…'
        : phase === 'sign_deposit'
          ? 'Sign the Hyperliquid deposit…'
          : phase === 'paying'
            ? 'Sending the fee…'
            : phase === 'depositing'
              ? 'Depositing to Hyperliquid…'
              : phase === 'waiting_hl'
                ? 'Waiting for Hyperliquid…'
                : phase === 'activating'
                  ? 'Turning revenue on…'
                  : null;

  const sendHint = feePaid
    ? fundedMet
      ? 'Fee is paid. Hyperliquid already has the 100 USDC.'
      : liveOwn
        ? `Send ${depositUsd.toFixed(0)} USDC on Arbitrum, then Activate. The $5 fee is already paid.`
        : `Send ${depositUsd.toFixed(0)} USDC on Arbitrum, then Activate.`
    : fundedMet
      ? `This builder already holds the 100 USDC Hyperliquid requires. Activate signs one gasless ${fee} USDC BuilderPad fee.`
      : imported
        ? `Fees pay the wallet you connected. Send ${arbNeed.toFixed(0)} USDC on Arbitrum: ${need} stays on Hyperliquid (refundable) + ${fee} BuilderPad fee. If you skip, HyperTrade keeps the cut.`
        : `Send ${arbNeed.toFixed(0)} USDC on Arbitrum. ${need} parks in your builder wallet on Hyperliquid (their requirement, refundable) + ${fee} BuilderPad fee. If you skip, HyperTrade keeps the cut.`;

  return (
    <div className={`${collectingOk ? 'card' : 'card-pop'} px-5 py-5`}>
      <h2 className="flex flex-wrap items-center gap-2 text-[17px] font-extrabold">
        {collectingOk ? (
          <>
            <IconCash size={18} className="text-success" />
            <span className="text-success">{collecting ? 'Revenue is on' : 'App revenue is on'}</span>
            <span className="tag-ok">
              <IconCheck size={9} /> Ready
            </span>
          </>
        ) : liveOwn ? (
          <>
            <IconLock size={18} className="text-warning" />
            <span className="text-warning">
              {unifyBlocked ? 'Keep this wallet Standard' : 'Refill to keep collecting (optional)'}
            </span>
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-extrabold text-warning">
              {unifyBlocked ? 'not Standard' : 'needs 100'}
            </span>
          </>
        ) : (
          <>
            <IconWallet size={18} className="text-brand" />
            Activate your app revenue (optional)
          </>
        )}
      </h2>
      {collectingOk ? (
        <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
          Revenue in your trading app pays this builder wallet.
        </p>
      ) : liveOwn && unifyBlocked ? (
        <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
          Hyperliquid only pays builder fees in Standard mode. Un-unify this wallet. Apps still
          point here.
        </p>
      ) : liveOwn ? (
        <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
          Hyperliquid requires 100 USDC in order to collect builder fees.
          <p>If you skip, builder fees will go to BuilderPad.</p>
        </p>
      ) : (
        <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">{sendHint}</p>
      )}

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <img
          src={`https://api.qrserver.com/v1/create-qr-code/?size=148x148&margin=8&color=06140c&bgcolor=ffffff&data=${encodeURIComponent(pair.builder_wallet)}`}
          alt="Deposit address QR"
          className="h-[124px] w-[124px] rounded-xl bg-white p-1.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
            <img src={arbIcon} alt="" className="h-4 w-4 rounded-full" />
            Arbitrum Network
          </div>
          <CopyAddress
            address={pair.builder_wallet}
            onExport={
              imported
                ? undefined
                : () => {
                    void exportWallet({ address: pair.builder_wallet }).catch((e) => {
                      setError(e instanceof Error ? e.message : 'Could not export builder key');
                    });
                  }
            }
          />
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <img src={usdcIcon} alt="" className="h-5 w-5 shrink-0" />
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-weak">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${Math.max(progress * 100, progress > 0 ? 4 : 0)}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] font-bold tabular text-fg-muted">
                {formatUsd(parked)} / {formatUsd(need)}
              </span>
            </div>
            {collectingOk ? null : (
              <p className="mt-1.5 text-[11px] font-semibold text-fg-subtle">
                {feePaid ? (
                  <span className="text-success">BuilderPad fee paid</span>
                ) : (
                  <>
                    + {formatUsd(fee)} BuilderPad fee
                    {available != null ? (
                      <>
                        {' '}
                        · Available{' '}
                        <span className="tabular text-fg">
                          {arbQ.isLoading ? <InlineSkel className="h-5 w-20" /> : formatUsd(available)}
                        </span>
                      </>
                    ) : null}
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </div>

      {collectingOk ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-hype btn-sm px-5 py-2 text-xs"
            disabled={busy}
            onClick={() => void activate()}
          >
            {phaseLabel ||
              (feePaid && fundedMet
                ? 'Activate'
                : feePaid
                  ? `Activate · deposit ${depositUsd.toFixed(0)} USDC`
                  : fundedMet
                    ? `Activate · ${fee.toFixed(0)} USDC fee`
                    : `Activate · ${arbNeed.toFixed(0)} USDC`)}
          </button>
        </div>
      )}

      {ok ? <p className="mt-3 text-xs text-brand">{ok}</p> : null}
      {error ? (
        <p className="mt-3 text-xs text-error">
          {error}{' '}
          {phase === 'idle' && !collectingOk ? (
            <button type="button" className="font-bold underline" onClick={() => void activate()}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      {sync.isError ? <p className="mt-3 text-xs text-error">{(sync.error as Error).message}</p> : null}
    </div>
  );
}

function CopyAddress({ address, onExport }: { address: string; onExport?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[13px] font-bold text-fg-muted">Builder wallet:</span>
      <code className="min-w-0 truncate font-mono text-[13px] font-bold">{shortAddr(address)}</code>
      <button
        type="button"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
        aria-label={copied ? 'Copied' : 'Copy address'}
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <IconCheck size={13} className="text-success" /> : <IconCopy size={13} />}
      </button>
      {onExport ? (
        <button type="button" className="btn-ghost btn-sm shrink-0 px-2 py-1 text-[11px]" onClick={onExport}>
          Export key
        </button>
      ) : null}
    </div>
  );
}

export function BuilderProvisionFallback({
  message,
  onCreate,
  creating,
  createError,
}: {
  message: string;
  onCreate: () => void;
  creating: boolean;
  createError?: string | null;
}) {
  return (
    <div className="card px-5 py-5">
      <h2 className="flex items-center gap-2 text-[17px] font-extrabold">
        <IconWallet size={18} className="text-brand" />
        This wallet cannot collect fees
      </h2>
      <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">{message}</p>
      <p className="mt-2 max-w-xl text-[13px] leading-5 text-fg-muted">
        Switch MetaMask to your Standard builder address and refresh, or create a new builder
        wallet. The connected wallet stays for login only — trading still uses a separate Privy
        wallet.
      </p>
      <button
        type="button"
        className="btn-primary mt-4 px-4 py-2 text-xs"
        disabled={creating}
        onClick={onCreate}
      >
        {creating ? 'Creating…' : 'Create a new builder wallet'}
      </button>
      {createError ? <p className="mt-3 text-xs text-error">{createError}</p> : null}
    </div>
  );
}
