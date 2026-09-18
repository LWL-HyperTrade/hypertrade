import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSendTransaction } from '@privy-io/react-auth';
import { isAddress, type Address } from 'viem';
import { useWebAuth } from '../lib/auth';
import { isWalletUserRejectedRequest, type Hex } from '../lib/hlTrade';
import { robinhoodAddressUrl, robinhoodTxUrl } from '../lib/pons';
import { formatEth, fetchRobinhoodEth } from '../lib/robinhoodEth';
import { decimalsTyped } from '../lib/amounts';
import {
  ETH_DECIMALS,
  formatEthInput,
  parseEthAmount,
  robinhoodGasReserve,
  spendableRobinhoodEth,
  withdrawRobinhoodEth,
} from '../lib/robinhoodWithdraw';
import { shortAddr } from '../lib/tenants';
import { IconCheck, IconChevron, IconClose, IconCopy, IconExternal, IconMail, IconQr } from './icons';
import { InlineSkel } from './skeleton';
import { renderSVG } from 'uqr';
import ethIcon from '../assets/images/eth-icon.webp';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';

type Props = {
  compact?: boolean;
};

export function RobinhoodBalance({ compact }: Props) {
  const { email, address, logout, getEthereumProvider, switchTradeChain } = useWebAuth();
  const { sendTransaction } = useSendTransaction();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawDest, setWithdrawDest] = useState('');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const ethQ = useQuery({
    queryKey: ['robinhood-eth', address],
    enabled: !!address,
    queryFn: () => fetchRobinhoodEth(address as Hex),
    refetchInterval: 15_000,
  });
  // Native send pays its own gas; Available / Max / validation all use balance − reserve.
  const reserveQ = useQuery({
    queryKey: ['robinhood-gas-reserve'],
    enabled: open && withdrawOpen,
    queryFn: robinhoodGasReserve,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  useEffect(() => {
    if (!open) {
      setCopyError(null);
      setQrOpen(false);
      setWithdrawOpen(false);
      setWithdrawDest('');
      setAmount('');
      setAmountTouched(false);
      setBusy(false);
      setError(null);
      setOk(null);
      setTxHash(null);
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

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setCopyError(null);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError('Could not copy address');
    }
  };

  const amountWei = parseEthAmount(amount);
  const amountBlank = !amount.trim();
  const tooManyDecimals = decimalsTyped(amount) > ETH_DECIMALS;
  const destOk = isAddress(withdrawDest.trim());
  const destSame =
    destOk && !!address && withdrawDest.trim().toLowerCase() === address.toLowerCase();
  const balanceWei = ethQ.data?.raw ?? null;
  const reserveWei = reserveQ.data ?? null;
  const spendableWei =
    balanceWei != null && reserveWei != null ? spendableRobinhoodEth(balanceWei, reserveWei) : null;
  const spendableKnown = spendableWei != null;
  const overBalance = amountWei != null && balanceWei != null && amountWei > balanceWei;
  const overSpendable =
    !overBalance && amountWei != null && spendableWei != null && amountWei > spendableWei;
  const amountInvalid =
    amountTouched && !amountBlank && (amountWei == null || overBalance || overSpendable);
  const amountError = !amountTouched
    ? null
    : amountBlank
      ? null
      : tooManyDecimals
        ? 'ETH supports up to 18 decimals'
        : amountWei == null
          ? 'Enter a valid amount'
          : overBalance
            ? 'Insufficient ETH on Robinhood Chain'
            : overSpendable
              ? `Leave ETH for gas — max ${formatEthInput(spendableWei!)} ETH`
              : null;
  const canSubmit =
    !!address &&
    !busy &&
    destOk &&
    !destSame &&
    amountWei != null &&
    spendableKnown &&
    !overBalance &&
    !overSpendable;

  const fillMax = () => {
    if (spendableWei == null) return;
    if (spendableWei <= 0n) {
      setError('Not enough ETH to cover Robinhood gas.');
      return;
    }
    setAmount(formatEthInput(spendableWei));
    setAmountTouched(true);
    setError(null);
  };

  const moveToExternal = async () => {
    setError(null);
    setOk(null);
    setTxHash(null);
    setAmountTouched(true);
    if (!address) return;
    if (!destOk) {
      setError('Enter a valid destination address');
      return;
    }
    if (destSame) {
      setError('Destination must be a different wallet.');
      return;
    }
    if (amountWei == null) {
      setError('Enter an amount');
      return;
    }
    if (overBalance) {
      setError('Insufficient ETH on Robinhood Chain');
      return;
    }
    if (spendableWei == null) {
      setError('Still estimating Robinhood gas. Try again in a moment.');
      return;
    }
    if (overSpendable) {
      setError(`Leave ETH for gas — max ${formatEthInput(spendableWei)} ETH`);
      return;
    }
    setBusy(true);
    try {
      const { txHash: hash } = await withdrawRobinhoodEth({
        from: address as Address,
        destination: withdrawDest,
        amountWei,
        balanceWei: ethQ.data?.raw,
        switchChain: switchTradeChain,
        getProvider: getEthereumProvider,
        sendTransaction,
      });
      setTxHash(hash);
      setOk('Withdraw submitted');
      setAmount('');
      setAmountTouched(false);
      void qc.invalidateQueries({ queryKey: ['robinhood-eth', address] });
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

  const label = ethQ.isLoading ? null : formatEth(ethQ.data?.formatted ?? 0);
  const iconSz = compact ? 14 : 16;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Robinhood ETH balance"
        className={
          compact
            ? 'inline-flex h-8 items-center gap-1.5 rounded-lg bg-fill-weak px-2.5 text-[12px] font-bold tabular text-fg hover:bg-fill-hover'
            : 'inline-flex h-7 max-w-[7.5rem] items-center gap-1 rounded-lg bg-fill-weak px-1.5 text-[11px] font-bold tabular text-fg hover:bg-fill-hover sm:h-8 sm:max-w-none sm:gap-1.5 sm:px-2.5 sm:text-[12px] lg:h-9 lg:rounded-xl lg:px-3 lg:text-[13px]'
        }
      >
        <span className="inline-flex shrink-0 items-center gap-0.5" aria-hidden>
          <img
            src={robinhoodIcon}
            alt=""
            className={compact ? 'rounded-full' : 'h-3 w-3 rounded-full lg:h-4 lg:w-4'}
            style={compact ? { width: iconSz, height: iconSz } : undefined}
          />
          <img
            src={ethIcon}
            alt=""
            className={compact ? 'rounded-full' : 'h-3 w-3 rounded-full lg:h-4 lg:w-4'}
            style={compact ? { width: iconSz, height: iconSz } : undefined}
          />
        </span>
        <span className="min-w-0 truncate">
          {label ?? <InlineSkel className="h-3.5 w-12" />}
        </span>
        <IconChevron
          size={compact ? 12 : 14}
          className={compact ? 'text-fg-subtle' : 'hidden text-fg-subtle lg:block'}
        />
      </button>

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
                aria-label="Robinhood Wallet"
                className="relative z-10 max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-t-2xl border border-stroke-weak bg-overlay p-4 text-fg sm:rounded-2xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <img src={robinhoodIcon} alt="" className="h-5 w-5 shrink-0 rounded-full" />
                      <div className="text-[15px] font-extrabold tracking-tight">Robinhood Wallet</div>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-fg-muted">
                      {email ? <IconMail size={12} className="shrink-0 text-fg-subtle" /> : null}
                      <span className="min-w-0 truncate">{email || (address ? shortAddr(address) : 'Wallet')}</span>
                    </div>
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
                    <img src={robinhoodIcon} alt="" className="h-3.5 w-3.5 rounded-full" />
                    <span>Deposit address · Robinhood</span>
                    {address ? (
                      <a
                        href={robinhoodAddressUrl(address)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="View on explorer"
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

                <div className="mt-3 rounded-xl bg-fill-weaker px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-fg-subtle">
                    <img src={ethIcon} alt="" className="h-3.5 w-3.5 rounded-full" />
                    Wallet Balance
                  </div>
                  <div className="text-[10px] text-fg-subtle">ETH</div>
                  <div className="mt-1 tabular text-[13px] font-bold">
                    {ethQ.isLoading ? <InlineSkel className="h-4 w-16" /> : formatEth(ethQ.data?.formatted ?? null)}
                  </div>
                </div>

                <p className="mt-3 text-[11px] leading-4 text-fg-subtle">
                  Send ETH on Robinhood Chain here for token launches.
                </p>

                <div className="mt-4">
                  <div className={`flex items-center gap-2 ${withdrawOpen ? 'justify-between' : 'justify-end'}`}>
                    {withdrawOpen ? (
                      <span className="text-[11px] font-bold text-fg-subtle">Amount</span>
                    ) : null}
                    <button
                      type="button"
                      className={`inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-bold ${
                        withdrawOpen
                          ? 'border-market-up/50 bg-market-up text-black'
                          : 'border-stroke-strong text-fg-muted hover:text-fg'
                      }`}
                      aria-pressed={withdrawOpen}
                      title="Send Robinhood ETH to an external wallet"
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
                  {withdrawOpen ? (
                    <>
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
                      <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
                        Available:{' '}
                        <span className="font-bold tabular text-fg">
                          {spendableWei == null ? '—' : formatEthInput(spendableWei)}
                        </span>{' '}
                        ETH
                        {balanceWei != null && reserveWei != null ? (
                          <span className="text-fg-subtle">
                            {' '}
                            · balance {formatEthInput(balanceWei)} · ~{formatEthInput(reserveWei)} kept for gas
                          </span>
                        ) : null}
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
                          placeholder="0"
                          inputMode="decimal"
                          aria-invalid={amountInvalid || undefined}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="btn-ghost btn-sm shrink-0 px-3 text-[11px]"
                          disabled={busy || spendableWei == null || spendableWei <= 0n}
                          onClick={fillMax}
                        >
                          Max
                        </button>
                      </div>
                      {amountError ? (
                        <p className="mt-1.5 text-[11px] text-market-down">{amountError}</p>
                      ) : destSame ? (
                        <p className="mt-1.5 text-[11px] text-market-down">
                          Destination must be a different wallet.
                        </p>
                      ) : null}
                      <button
                        type="button"
                        disabled={!canSubmit}
                        onClick={() => void moveToExternal()}
                        className="btn-primary btn-sm mt-2 w-full py-2.5 text-[13px]"
                      >
                        {busy ? 'Confirm in wallet…' : 'Withdraw to External Wallet'}
                      </button>
                      <p className="mt-1.5 text-[11px] leading-4 text-fg-subtle">
                        You pay Robinhood ETH gas from this balance. No minimum.
                      </p>
                    </>
                  ) : null}
                  {ok ? (
                    <p className="mt-2 text-[11px] text-market-up">
                      {ok}
                      {txHash ? (
                        <>
                          {' '}
                          <a
                            className="underline"
                            href={robinhoodTxUrl(txHash)}
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
                </div>

                {copyError ? <p className="mt-2 text-[11px] text-market-down">{copyError}</p> : null}
                {ethQ.isError ? (
                  <p className="mt-2 text-[11px] text-warning">
                    Could not read Robinhood ETH. Set VITE_ROBINHOOD_RPC_URL if the public RPC is
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
                    onClick={() => setQrOpen(false)}
                  >
                    <div
                      className="w-full max-w-[240px] rounded-2xl border border-stroke-weak bg-overlay p-4 text-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="text-[13px] font-extrabold">Robinhood address</div>
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
