import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAddress } from 'viem';
import { decimalsTyped, formatTokenAmount, parseTokenAmount } from '../lib/amounts';
import { depositWithPermit, fetchTransferLimit, listMyTenants } from '../lib/api';
import { ARBITRUM_CHAIN_ID, fetchArbUsdc, MIN_BRIDGE2_USDC, signBridge2Permit } from '../lib/arbUsdc';
import { MIN_EXTERNAL_WITHDRAW_USDC, withdrawArbUsdcToExternal } from '../lib/arbWithdraw';
import { useWebAuth } from '../lib/auth';
import { fetchClearinghouse, formatUsd } from '../lib/hlMarket';
import {
  HL_WITHDRAW_FEE_USDC,
  MIN_HL_WITHDRAW_USDC,
  isWalletUserRejectedRequest,
  netHlWithdrawReceive,
  withdrawFromHyperliquid,
  type Hex,
} from '../lib/hlTrade';
import { shortAddr } from '../lib/tenants';
import { tenantAppHref } from '../lib/config';
import { ensureTradeWalletChain } from '../lib/walletChain';
import { IconCheck, IconChevron, IconClose, IconCopy, IconExternal, IconMail, IconQr, IconSwap } from './icons';
import { AppHref } from './AppHref';
import { RobinhoodBalance } from './RobinhoodBalance';
import { InlineSkel, Skel } from './skeleton';
import { renderSVG } from 'uqr';
import arbIcon from '../assets/images/arb-icon.webp';
import usdcIcon from '../assets/images/usdc-icon.webp';

type Props = {
  compact?: boolean;
  /** Trade terminal is HL-only — hide Robinhood Chain balance chip. */
  hideRobinhood?: boolean;
  /** Drop the profile face chip (saves header space on creator mobile). */
  hideProfile?: boolean;
};

const USDC_DECIMALS = 6;
/** HL withdraw is sent as `toFixed(2)`; hold input to that. */
const HL_USD_DECIMALS = 2;

function parseAmount(raw: string): number | null {
  const amt = Number(raw.trim());
  if (!Number.isFinite(amt)) return null;
  return amt;
}

export function WalletSheet({ compact, hideRobinhood, hideProfile }: Props) {
  const {
    email,
    address,
    builderAddress,
    logout,
    getEthereumProvider,
    getAccessToken,
    switchTradeChain,
    authenticated,
  } = useWebAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawDest, setWithdrawDest] = useState('');
  const [direction, setDirection] = useState<'toTrade' | 'toWallet'>('toTrade');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const mineQ = useQuery({
    queryKey: ['my-tenants'],
    enabled: authenticated,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return listMyTenants(token);
    },
    staleTime: 30_000,
  });
  // Prefer a live app that has an uploaded logo — never the Privy/X social avatar.
  const myApp =
    mineQ.data?.find((t) => t.status === 'live' && !!t.logo_url?.trim()) ??
    mineQ.data?.find((t) => t.status === 'live') ??
    mineQ.data?.find((t) => !!t.logo_url?.trim()) ??
    mineQ.data?.[0];
  const profileTo = !myApp
    ? '/apps'
    : myApp.status !== 'live'
      ? '/create'
      : tenantAppHref(myApp.slug);
  const faceUrl = myApp?.logo_url?.trim() || null;
  const faceLetter = (myApp?.app_name || email || address || '?').trim().charAt(0).toUpperCase();
  // Don't flash the email/address letter while my-tenants (and its logo) is still loading.
  const facePending = authenticated && mineQ.isPending;
  const [faceReady, setFaceReady] = useState(false);
  useEffect(() => {
    setFaceReady(false);
  }, [faceUrl]);

  const walletQ = useQuery({
    queryKey: ['arb-usdc', address],
    enabled: !!address && (open || !compact),
    queryFn: () => fetchArbUsdc(address as Hex),
    refetchInterval: 15_000,
  });
  const tradeQ = useQuery({
    queryKey: ['hl', 'clearinghouse', address],
    enabled: !!address,
    queryFn: () => fetchClearinghouse(address!),
    refetchInterval: 8_000,
  });
  const limitQ = useQuery({
    queryKey: ['wallet-transfer-limit', address],
    enabled: authenticated && !!address && open && withdrawOpen,
    queryFn: async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      return fetchTransferLimit(address!, token);
    },
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!open) {
      setError(null);
      setOk(null);
      setTxHash(null);
      setAmountTouched(false);
      setDirection('toTrade');
      setQrOpen(false);
      setWithdrawOpen(false);
      setWithdrawDest('');
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (qrOpen) {
        setQrOpen(false);
        return;
      }
      setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, qrOpen]);

  const toWallet = direction === 'toWallet';
  /** Wallet-balance paths move on-chain USDC (6 dp). HL trade balance is sent as toFixed(2). */
  const fromWalletBalance = withdrawOpen || !toWallet;
  const minUsd = withdrawOpen
    ? MIN_EXTERNAL_WITHDRAW_USDC
    : toWallet
      ? MIN_HL_WITHDRAW_USDC
      : MIN_BRIDGE2_USDC;
  const amt = parseAmount(amount);
  const amountBlank = !amount.trim();
  const usdcDecimals = walletQ.data?.decimals ?? USDC_DECIMALS;
  const maxDecimals = fromWalletBalance ? usdcDecimals : HL_USD_DECIMALS;
  const tooManyDecimals = decimalsTyped(amount) > maxDecimals;
  const amountUnits = fromWalletBalance ? parseTokenAmount(amount, usdcDecimals) : null;
  const walletRaw = walletQ.data?.raw ?? null;
  const withdrawableUsd = tradeQ.data?.withdrawable ?? 0;
  /** HL withdrawable floored to cents — what Available shows and Max fills. */
  const withdrawableCents = Number.isFinite(withdrawableUsd)
    ? Math.max(0, Math.floor(withdrawableUsd * 100 + 1e-6))
    : 0;
  const amountCents = amt != null ? Math.round(amt * 100) : null;
  const amountTooLow = amt != null && amt > 0 && amt < minUsd;
  const overWallet =
    fromWalletBalance && amountUnits != null && walletRaw != null && amountUnits > walletRaw;
  const overTrade = !fromWalletBalance && amountCents != null && amountCents > withdrawableCents;
  const amountInvalid =
    amountTouched &&
    !amountBlank &&
    (amt == null || amt <= 0 || tooManyDecimals || amountTooLow || overWallet || overTrade);
  const amountError = !amountTouched
    ? null
    : amountBlank
      ? null
      : tooManyDecimals
        ? `Up to ${maxDecimals} decimals`
        : amt == null || amt <= 0
          ? 'Enter a valid amount'
          : amountTooLow
            ? `Minimum is $${minUsd}`
            : overWallet
              ? 'Insufficient Arbitrum USDC'
              : overTrade
                ? 'Not enough trade balance'
                : null;

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy address');
    }
  };

  const receiveUsd = amt != null && amt >= MIN_HL_WITHDRAW_USDC ? netHlWithdrawReceive(amt) : null;

  // Same guard as Robinhood withdraw: HD 0 may have been left on Robinhood
  // Chain by a Pons action in this session. Never trust one provider instance.
  const ensureArbitrumWallet = () =>
    ensureTradeWalletChain({
      chainId: ARBITRUM_CHAIN_ID,
      chainName: 'Arbitrum',
      switchChain: switchTradeChain,
      getProvider: getEthereumProvider,
    });

  const moveToTrade = async () => {
    setError(null);
    setOk(null);
    setTxHash(null);
    setAmountTouched(true);
    if (!address) return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setError('Trade wallet required — fund the builder from Home.');
      return;
    }
    if (amt == null || amt <= 0) {
      setError('Enter an amount');
      return;
    }
    if (amt < MIN_BRIDGE2_USDC) {
      setError(`Minimum is $${MIN_BRIDGE2_USDC}`);
      return;
    }
    if (tooManyDecimals || amountUnits == null) {
      setError(`Up to ${usdcDecimals} decimals`);
      return;
    }
    if (overWallet) {
      setError('Insufficient Arbitrum USDC');
      return;
    }
    setBusy(true);
    try {
      const provider = await ensureArbitrumWallet();
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const permit = await signBridge2Permit({
        provider,
        user: address,
        amountUsdc: amount.trim(),
      });
      const res = await depositWithPermit({ user: address, ...permit }, token);
      const hash = res?.txHash;
      if (!hash) throw new Error('Deposit did not return a transaction');
      setTxHash(hash.startsWith('0x') ? hash : `0x${hash}`);
      setOk('Deposit submitted — trade balance updates shortly');
      setAmount('');
      setAmountTouched(false);
      void qc.invalidateQueries({ queryKey: ['arb-usdc', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) {
        setError('Wallet request was rejected.');
      } else {
        setError(e instanceof Error ? e.message : 'Deposit failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const moveToWallet = async () => {
    setError(null);
    setOk(null);
    setTxHash(null);
    setAmountTouched(true);
    if (!address) return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setError('Trade wallet required — fund the builder from Home.');
      return;
    }
    if (amt == null || amt <= 0) {
      setError('Enter an amount');
      return;
    }
    if (amt < MIN_HL_WITHDRAW_USDC) {
      setError(`Minimum is $${MIN_HL_WITHDRAW_USDC}`);
      return;
    }
    if (tooManyDecimals) {
      setError(`Up to ${HL_USD_DECIMALS} decimals`);
      return;
    }
    if (overTrade) {
      setError('Not enough trade balance');
      return;
    }
    setBusy(true);
    try {
      const provider = await ensureArbitrumWallet();
      const amtStr = amt.toFixed(2);
      await withdrawFromHyperliquid({
        provider,
        userAddress: address as Hex,
        destination: address as Hex,
        amountUsd: amtStr,
      });
      setOk(
        `Withdrawal submitted — ${formatUsd(netHlWithdrawReceive(amt))} lands on Arbitrum after the $${HL_WITHDRAW_FEE_USDC} fee (~3–5 min)`,
      );
      setAmount('');
      setAmountTouched(false);
      void qc.invalidateQueries({ queryKey: ['arb-usdc', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) {
        setError('Wallet request was rejected.');
      } else {
        const msg = e instanceof Error ? e.message : 'Withdraw failed';
        setError(/nonce|already in progress/i.test(msg) ? 'Please wait a moment and try again.' : msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const moveToExternal = async () => {
    setError(null);
    setOk(null);
    setTxHash(null);
    setAmountTouched(true);
    if (!address) return;
    const dest = withdrawDest.trim();
    if (!isAddress(dest)) {
      setError('Enter a valid destination address.');
      return;
    }
    if (dest.toLowerCase() === address.toLowerCase()) {
      setError('Destination must be a different wallet.');
      return;
    }
    if (amt == null || amt <= 0) {
      setError('Enter an amount');
      return;
    }
    if (amt < MIN_EXTERNAL_WITHDRAW_USDC) {
      setError(`Minimum is $${MIN_EXTERNAL_WITHDRAW_USDC}`);
      return;
    }
    if (tooManyDecimals || amountUnits == null) {
      setError(`Up to ${usdcDecimals} decimals`);
      return;
    }
    if (overWallet) {
      setError('Insufficient Arbitrum USDC');
      return;
    }
    if (limitQ.data && limitQ.data.remaining === 0) {
      setError('Daily withdraw limit reached. Try again later.');
      return;
    }
    setBusy(true);
    try {
      const provider = await ensureArbitrumWallet();
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again');
      const { txHash: hash } = await withdrawArbUsdcToExternal({
        provider,
        user: address as Hex,
        destination: dest,
        amountUsdc: amount.trim(),
        accessToken: token,
      });
      setTxHash(hash);
      setOk(`Sent ${formatUsd(amt)} USDC on Arbitrum`);
      setAmount('');
      setWithdrawDest('');
      setAmountTouched(false);
      void qc.invalidateQueries({ queryKey: ['arb-usdc', address] });
      void qc.invalidateQueries({ queryKey: ['wallet-transfer-limit', address] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) {
        setError('Wallet request was rejected.');
      } else {
        setError(e instanceof Error ? e.message : 'Withdraw failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const tradeLabel = tradeQ.isLoading ? null : formatUsd(tradeQ.data?.accountValue ?? 0);
  const canSubmit = withdrawOpen
    ? !!address &&
      !busy &&
      isAddress(withdrawDest.trim()) &&
      amt != null &&
      amt >= MIN_EXTERNAL_WITHDRAW_USDC &&
      amountUnits != null &&
      !overWallet &&
      !(limitQ.data && limitQ.data.remaining === 0)
    : toWallet
      ? !!address &&
        !busy &&
        amt != null &&
        amt >= MIN_HL_WITHDRAW_USDC &&
        !tooManyDecimals &&
        !overTrade
      : !!address &&
        !busy &&
        amt != null &&
        amt >= MIN_BRIDGE2_USDC &&
        amountUnits != null &&
        !overWallet;

  const walletAvailable = walletQ.isLoading
    ? '—'
    : walletRaw == null
      ? '—'
      : formatTokenAmount(walletRaw, usdcDecimals);
  const tradeAvailable = tradeQ.isLoading ? '—' : (withdrawableCents / 100).toFixed(2);

  const fillMax = () => {
    if (!fromWalletBalance) {
      if (withdrawableCents <= 0) return;
      setAmount((withdrawableCents / 100).toFixed(2));
    } else {
      if (walletRaw == null || walletRaw <= 0n) return;
      setAmount(formatTokenAmount(walletRaw, usdcDecimals));
    }
    setAmountTouched(true);
    setError(null);
  };

  const iconSz = compact ? 14 : 16;

  return (
    <>
      <div className={`flex items-center ${compact ? 'gap-1.5' : 'gap-1 lg:gap-2.5'}`}>
        {hideRobinhood ? null : <RobinhoodBalance compact={compact} />}

        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Trade balance and deposit"
          className={
            compact
              ? 'inline-flex h-8 items-center gap-1 rounded-lg bg-fill-weak px-2 text-[11px] font-bold leading-none tabular text-fg hover:bg-fill-hover sm:max-w-none sm:gap-1.5 sm:px-2.5 sm:text-[12px]'
              : 'inline-flex h-7 max-w-[7.5rem] items-center gap-1 rounded-lg bg-fill-weak px-1.5 text-[11px] font-bold tabular text-fg hover:bg-fill-hover sm:h-8 sm:max-w-none sm:gap-1.5 sm:px-2.5 sm:text-[12px] lg:h-9 lg:rounded-xl lg:px-3 lg:text-[13px]'
          }
        >
          <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden>
            <img
              src={arbIcon}
              alt=""
              className={compact ? 'block rounded-full' : 'h-3 w-3 rounded-full lg:h-4 lg:w-4'}
              style={compact ? { width: iconSz, height: iconSz } : undefined}
            />
            <img
              src={usdcIcon}
              alt=""
              className={compact ? 'block rounded-full' : 'h-3 w-3 rounded-full lg:h-4 lg:w-4'}
              style={compact ? { width: iconSz, height: iconSz } : undefined}
            />
          </span>
          <span className="min-w-0 truncate leading-none">
            {tradeLabel ?? <InlineSkel className="h-3.5 w-12" />}
          </span>
          <IconChevron
            size={compact ? 12 : 14}
            className={compact ? 'hidden text-fg-subtle sm:block' : 'hidden text-fg-subtle lg:block'}
          />
        </button>

        <AppHref
          to={profileTo}
          aria-label={myApp ? `Open ${myApp.app_name}` : 'My projects'}
          className={`relative shrink-0 ${hideProfile ? 'hidden' : compact ? 'max-sm:hidden' : ''}`}
        >
          {(() => {
            const ring = compact
              ? 'h-8 w-8 rounded-full ring-1 ring-stroke-strong'
              : 'h-7 w-7 rounded-full ring-1 ring-stroke-strong lg:h-9 lg:w-9';
            const showSkel = facePending || (!!faceUrl && !faceReady);
            if (!facePending && !faceUrl) {
              return (
                <div
                  className={`flex items-center justify-center bg-brand font-black text-black ${ring} ${
                    compact ? 'text-[12px]' : 'text-[11px] lg:text-[13px]'
                  }`}
                >
                  {faceLetter}
                </div>
              );
            }
            return (
              <span className={`relative block overflow-hidden ${ring}`}>
                {showSkel ? <Skel className="absolute inset-0 !rounded-full" /> : null}
                {faceUrl ? (
                  <img
                    src={faceUrl}
                    alt=""
                    className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${
                      faceReady ? 'opacity-100' : 'opacity-0'
                    }`}
                    ref={(el) => {
                      if (el?.complete && el.naturalWidth > 0) setFaceReady(true);
                    }}
                    onLoad={() => setFaceReady(true)}
                    onError={() => setFaceReady(true)}
                  />
                ) : null}
              </span>
            );
          })()}
        </AppHref>
      </div>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-start sm:justify-end sm:p-6">
              <button
                type="button"
                className="absolute inset-0 bg-sunken/70"
                aria-label="Close wallet"
                onClick={() => setOpen(false)}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Arbitrum Wallet"
                className="relative z-10 max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-t-2xl border border-stroke-weak bg-overlay p-4 text-fg sm:rounded-2xl"
              >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <img src={arbIcon} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                  <div className="text-[15px] font-extrabold tracking-tight">Arbitrum Wallet</div>
                </div>
                {email || address ? (
                  <span
                    className="mt-1.5 inline-flex max-w-full items-center gap-1 truncate rounded-full border border-stroke-weak bg-fill-weak px-2 py-0.5 text-[11px] font-semibold text-fg-muted"
                    title={email || address || undefined}
                  >
                    {email ? <IconMail size={11} className="shrink-0 text-fg-subtle" /> : null}
                    <span className="min-w-0 truncate">{email || (address ? shortAddr(address) : 'Wallet')}</span>
                  </span>
                ) : (
                  <div className="mt-0.5 text-[12px] text-fg-muted">Wallet</div>
                )}
              </div>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-fg-subtle hover:text-fg"
                onClick={() => setOpen(false)}
              >
                Close
                <IconClose size={14} />
              </button>
            </div>

            <div className="mt-3 rounded-xl bg-fill-weaker px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
                <img src={arbIcon} alt="" className="h-3.5 w-3.5 rounded-full" />
                <span>Deposit address · Arbitrum</span>
                {address ? (
                  <a
                    href={`https://arbiscan.io/address/${address}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View on Arbiscan"
                    className="inline-flex text-fg-subtle hover:text-fg"
                  >
                    <IconExternal size={12} />
                  </a>
                ) : null}
              </div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1 break-all font-mono text-[12px]">
                  {address || 'Waiting for wallet…'}
                </div>
                {address ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
                      aria-label="Show QR code"
                      onClick={() => setQrOpen(true)}
                    >
                      <IconQr size={14} />
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-stroke-strong text-fg-muted hover:text-fg"
                      aria-label={copied ? 'Copied' : 'Copy address'}
                      onClick={() => void copy()}
                    >
                      {copied ? <IconCheck size={14} className="text-success" /> : <IconCopy size={14} />}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
              <Stat
                label="Wallet Balance"
                icon={<img src={usdcIcon} alt="" className="h-3.5 w-3.5" />}
                sub="Withdrawable"
                value={walletQ.isLoading ? <InlineSkel className="h-4 w-16" /> : formatUsd(walletQ.data?.formatted ?? null)}
              />
              <Stat
                label="Trade balance"
                icon={<img src={usdcIcon} alt="" className="h-3.5 w-3.5" />}
                sub="Ready to trade"
                value={tradeQ.isLoading ? <InlineSkel className="h-4 w-16" /> : formatUsd(tradeQ.data?.accountValue ?? null)}
              />
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-fg-subtle">Amount</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-bold ${
                      !withdrawOpen && toWallet
                        ? 'border-brand/40 bg-brand-soft text-brand'
                        : 'border-stroke-strong text-fg-muted hover:text-fg'
                    }`}
                    aria-pressed={!withdrawOpen && toWallet}
                    title={toWallet ? 'Switch to deposit to trade balance' : 'Switch to deposit to wallet balance'}
                    disabled={busy}
                    onClick={() => {
                      if (withdrawOpen) {
                        setWithdrawOpen(false);
                        setError(null);
                        setOk(null);
                        setTxHash(null);
                        return;
                      }
                      setDirection((d) => (d === 'toTrade' ? 'toWallet' : 'toTrade'));
                      setAmountTouched(false);
                      setError(null);
                      setOk(null);
                      setTxHash(null);
                    }}
                  >
                    <IconSwap size={12} />
                    Transfer
                  </button>
                  <button
                    type="button"
                    className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-bold ${
                      withdrawOpen
                        ? 'border-market-up/50 bg-market-up text-black'
                        : 'border-stroke-strong text-fg-muted hover:text-fg'
                    }`}
                    aria-pressed={withdrawOpen}
                    title="Send Arbitrum USDC to an external wallet"
                    disabled={busy}
                    onClick={() => {
                      setWithdrawOpen((v) => !v);
                      setAmountTouched(false);
                      setError(null);
                      setOk(null);
                      setTxHash(null);
                    }}
                  >
                    Withdraw
                  </button>
                </div>
              </div>
              {withdrawOpen ? (
                <label className="mt-2 block text-[11px] text-fg-subtle">
                  Destination
                  <input
                    className="field mt-1 w-full py-1.5 font-mono text-[12px]"
                    value={withdrawDest}
                    onChange={(e) => {
                      setWithdrawDest(e.target.value);
                      setError(null);
                    }}
                    placeholder="0x…"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              ) : null}
              <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
                Available:{' '}
                <span className="font-bold tabular text-fg">
                  {fromWalletBalance ? walletAvailable : tradeAvailable}
                </span>{' '}
                USDC
              </p>
              <div className="mt-1.5 flex gap-2">
                <input
                  className="field min-w-0 flex-1 py-1.5 text-[13px] tabular"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setAmountTouched(true);
                    setError(null);
                  }}
                  onBlur={() => setAmountTouched(true)}
                  placeholder={`${minUsd}`}
                  inputMode="decimal"
                  aria-invalid={amountInvalid || undefined}
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm shrink-0 px-3 text-[11px]"
                  disabled={fromWalletBalance ? walletRaw == null || walletRaw <= 0n : withdrawableCents <= 0}
                  onClick={fillMax}
                >
                  Max
                </button>
              </div>
            </div>
            {amountError ? (
              <p className="mt-1.5 text-[11px] text-market-down">{amountError}</p>
            ) : null}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() =>
                void (withdrawOpen ? moveToExternal() : toWallet ? moveToWallet() : moveToTrade())
              }
              className="btn-primary btn-sm mt-2 w-full py-2.5 text-[13px]"
            >
              {busy
                ? 'Confirm in wallet…'
                : withdrawOpen
                  ? 'Withdraw to External Wallet'
                  : toWallet
                    ? 'Transfer to Wallet Balance'
                    : 'Transfer to Trade Balance'}
            </button>
            <p className="mt-1.5 text-[11px] leading-4 text-fg-subtle">
              {withdrawOpen
                ? `Gasless. Minimum is $${MIN_EXTERNAL_WITHDRAW_USDC}.`
                : toWallet
                  ? `Transfer fee: ${HL_WITHDRAW_FEE_USDC} USDC — Minimum is ${MIN_HL_WITHDRAW_USDC} USDC`
                  : `Transfer fee: Free — Minimum is ${MIN_BRIDGE2_USDC} USDC`}
            </p>
            {/*withdrawOpen && limitQ.data ? (
              <p className="mt-0.5 text-[11px] text-fg-muted">
                {limitQ.data.remaining} of {limitQ.data.max} gasless sends left today
                {limitQ.data.remaining === 0 && limitQ.data.resetInSeconds
                  ? ` · resets in ${Math.ceil(limitQ.data.resetInSeconds / 3600)}h`
                  : ''}
              </p>
            ) : null*/}
            {!withdrawOpen && toWallet && receiveUsd != null ? (
              <p className="mt-0.5 text-[11px] text-fg-muted">
                You receive {formatUsd(receiveUsd)} on Arbitrum after the fee.
              </p>
            ) : null}
            {ok ? (
              <p className="mt-2 text-[11px] text-market-up">
                {ok}
                {txHash ? (
                  <>
                    {' '}
                    <a
                      className="underline"
                      href={`https://arbiscan.io/tx/${txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {txHash.slice(0, 10)}…
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {error && error !== amountError ? (
              <p className="mt-2 text-[11px] text-market-down">{error}</p>
            ) : null}
            {walletQ.isError ? (
              <p className="mt-2 text-[11px] text-warning">
                Could not read Arbitrum USDC. Set VITE_ARBITRUM_RPC_URL if the public RPC is
                rate-limited.
              </p>
            ) : null}

            <button
              type="button"
              className="btn-ghost btn-sm mt-4 w-full py-2 text-[12px]"
              onClick={() => void logout()}
            >
              Sign out
            </button>
            {qrOpen && address ? (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 p-4"
                onClick={(e) => {
                  e.stopPropagation();
                  setQrOpen(false);
                }}
              >
                <div
                  className="w-full max-w-[240px] rounded-2xl border border-stroke-weak bg-overlay p-4 text-center"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-[13px] font-extrabold">Arbitrum address</div>
                  <div
                    className="mx-auto mt-3 w-[180px] overflow-hidden rounded-xl bg-white p-2 [&_svg]:h-full [&_svg]:w-full"
                    dangerouslySetInnerHTML={{
                      __html: renderSVG(address, { ecc: 'M', pixelSize: 6, border: 2 }),
                    }}
                  />
                  <p className="mt-2 break-all font-mono text-[10px] leading-4 text-fg-muted">{address}</p>
                  <button
                    type="button"
                    className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-fg-subtle hover:text-fg"
                    onClick={() => setQrOpen(false)}
                  >
                    Close
                    <IconClose size={14} />
                  </button>
                </div>
              </div>
            ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Stat({
  label,
  sub,
  value,
  icon,
}: {
  label: string;
  sub: string;
  value: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-fill-weaker px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
        {icon}
        {label}
      </div>
      <div className="text-[10px] text-fg-subtle">{sub}</div>
      <div className="mt-1 tabular text-[13px] font-bold">{value}</div>
    </div>
  );
}
