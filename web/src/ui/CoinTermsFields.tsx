import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatEther, formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { fetchPonsQuotes } from '../lib/api';
import { PONS_SYMBOL_MAX } from '../lib/earnings';
import {
  MAX_SNIPE_TAX_EXEMPTIONS,
  NATIVE_QUOTE,
  isNativeQuote,
  quoteInitialBuy,
  readErc20Balance,
  readLaunchFee,
  readLaunchTerms,
  readMaxCreatorTaxBps,
  readNativeBalance,
  readSnipeTax,
} from '../lib/pons';
import { quoteLogoSrc } from '../lib/quoteLogos';
import { shortAddr, type PonsQuote } from '../lib/tenants';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';
import hypeIcon from '../assets/images/hype-icon.webp';
import { BouncingDots } from './BouncingDots';
import { IconChevron, IconClose } from './icons';

/** Candidate chips; the factory's live `maxCreatorTaxBps()` trims the list. */
export const PONS_TAX_CHIPS = [0, 100, 200, 300, 500, 1000];
export const PONS_DEFAULT_MAX_TAX_BPS = 500;

export type CoinTerms = {
  symbol: string;
  /** Zero address = native ETH. */
  pairToken: string;
  /** Human amount in quote units. */
  devBuy: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  creatorFeeRecipient: string;
  /** Extra wallets exempt from the launch-window snipe tax. Free text: one per line or comma-separated. */
  teamWallets: string;
  advancedOpen: boolean;
};

export const EMPTY_COIN_TERMS: CoinTerms = {
  symbol: '',
  pairToken: NATIVE_QUOTE,
  devBuy: '',
  creatorTaxBps: 0,
  // Off by default on our factory: when on, 25% of the creator's fee share is
  // spent buying the token into the 5-year vest instead of paid out. Opt-in.
  buybackEnabled: false,
  creatorFeeRecipient: '',
  teamWallets: '',
  advancedOpen: false,
};

/** Parse the team-wallets text into checksummed-valid addresses + the junk we could not read. */
export function parseTeamWallets(text: string | undefined): { valid: Address[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: Address[] = [];
  const invalid: string[] = [];
  for (const raw of (text ?? '').split(/[\s,;]+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (isAddress(t)) {
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        valid.push(t as Address);
      }
    } else {
      invalid.push(t);
    }
  }
  return { valid, invalid };
}

/** Left in the wallet on a native "Max" dev buy so the launch tx itself can pay gas. */
const LAUNCH_GAS_RESERVE = 1_500_000_000_000_000n; // 0.0015 ETH

export type LaunchFunding = {
  /** `true` = wallet can cover fee + gas (+ dev buy); `false` = short; `null` = still reading. */
  ready: boolean | null;
  /** ETH the launch tx needs on Robinhood Chain (fee + gas reserve + native dev buy). */
  ethNeeded: bigint;
  ethBalance: bigint | null;
  /** ERC-20 quote only: dev-buy amount vs. balance. */
  quoteNeeded: bigint;
  quoteBalance: bigint | null;
  quoteDecimals: number;
  native: boolean;
  /** Human line for the button area, empty when ready or unknown. */
  shortfall: string;
  /** The raw dev-buy amount parsed with the quote's decimals (`null` = unparsable). */
  devBuyRaw: bigint | null;
};

/**
 * Can this wallet actually pay for the launch as configured? Reads the live
 * launch fee and the wallet's ETH (+ quote-asset) balance on Robinhood Chain.
 * Shared by the form (Available / Max / red field) and the Publish / Launch
 * buttons, so the CTA is muted before the wallet popup ever opens.
 */
export function useLaunchFunding(terms: CoinTerms, hd0: string | null, quoteSymbol: string): LaunchFunding {
  const native = isNativeQuote(terms.pairToken);
  const fee = useQuery({ queryKey: ['pons-launch-fee'], queryFn: readLaunchFee, staleTime: 5 * 60_000 });
  const launchTerms = useQuery({
    queryKey: ['pons-launch-terms', terms.pairToken],
    enabled: !!terms.pairToken,
    queryFn: () => readLaunchTerms(terms.pairToken as Address),
    staleTime: 60_000,
  });
  const quoteDecimals = launchTerms.data?.quoteDecimals ?? 18;
  const eth = useQuery({
    queryKey: ['pons-eth-balance', hd0],
    enabled: !!hd0,
    queryFn: () => readNativeBalance(hd0 as Address),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
  const quote = useQuery({
    queryKey: ['pons-quote-balance', terms.pairToken, hd0],
    enabled: !!hd0 && !native,
    queryFn: () => readErc20Balance(terms.pairToken as Address, hd0 as Address),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
  const devBuyRaw = parseDevBuy(terms.devBuy, quoteDecimals);
  const devBuy = devBuyRaw != null && devBuyRaw > 0n ? devBuyRaw : 0n;
  const ethNeeded = (fee.data ?? 0n) + LAUNCH_GAS_RESERVE + (native ? devBuy : 0n);
  const quoteNeeded = native ? 0n : devBuy;
  const ethBalance = eth.data ?? null;
  const quoteBalance = native ? ethBalance : (quote.data ?? null);

  let ready: boolean | null;
  if (!hd0) ready = null;
  else if (fee.isError || eth.isError) ready = true; // do not block on a flaky RPC; the launch path re-checks
  else if (fee.data == null || ethBalance == null || (!native && devBuy > 0n && quote.data == null)) ready = null;
  else ready = ethBalance >= ethNeeded && (native || (quote.data ?? 0n) >= quoteNeeded);

  let shortfall = '';
  if (ready === false && ethBalance != null) {
    if (ethBalance < ethNeeded) {
      shortfall = `Needs about ${trimTrailingZeros(formatEther(ethNeeded))} ETH on Robinhood Chain for the launch fee${native && devBuy > 0n ? ', dev buy' : ''} and gas`;
    } else {
      shortfall = `Needs ${fmtAmount(quoteNeeded, quoteDecimals)} ${quoteSymbol} for the dev buy`;
    }
  }

  return { ready, ethNeeded, ethBalance, quoteNeeded, quoteBalance, quoteDecimals, native, shortfall, devBuyRaw };
}

function parseDevBuy(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!t || t === '.') return 0n;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

function fmtAmount(raw: bigint, decimals: number, maxFrac = 4): string {
  const v = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  if (v >= 1_000_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
  return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function trimTrailingZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function usePonsQuotes() {
  return useQuery({
    queryKey: ['pons-quotes'],
    queryFn: fetchPonsQuotes,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function quoteSymbolFor(quotes: PonsQuote[] | undefined, pairToken: string): string {
  const q = quotes?.find((x) => x.pair_token.toLowerCase() === pairToken.toLowerCase());
  return q?.symbol ?? (pairToken.toLowerCase() === NATIVE_QUOTE ? 'ETH' : '…');
}

function QuoteLogo({ symbol, logoUrl, size = 18 }: { symbol: string; logoUrl?: string | null; size?: number }) {
  const src = quoteLogoSrc(symbol, logoUrl);
  if (!src) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-fill-weak text-[9px] font-extrabold text-fg-subtle"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {symbol.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

function QuoteAssetSelect({
  list,
  value,
  onChange,
  loading,
  disabled,
}: {
  list: PonsQuote[];
  value: string;
  onChange: (pairToken: string) => void;
  loading: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected =
    list.find((q) => q.pair_token.toLowerCase() === value.toLowerCase()) ?? list[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative mt-1.5">
      <button
        type="button"
        className="field flex w-full items-center gap-2 pr-9 text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={loading || undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {loading ? (
          <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-fg-subtle">
            Fetching assets
            <BouncingDots />
          </span>
        ) : (
          <>
            {selected ? <QuoteLogo symbol={selected.symbol} logoUrl={selected.logo_url} /> : null}
            <span className="min-w-0 flex-1 truncate">
              {selected ? selected.symbol : 'No quotes available'}
            </span>
          </>
        )}
        <IconChevron
          size={14}
          className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && list.length > 0 ? (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border-2 border-stroke-strong bg-surface py-1 shadow-[3px_3px_0_0_#0a2e1c]"
        >
          {list.map((q) => {
            const active = selected?.pair_token.toLowerCase() === q.pair_token.toLowerCase();
            return (
              <li key={q.pair_token} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] font-semibold hover:bg-fill-hover ${
                    active ? 'bg-brand-soft text-brand' : 'text-fg'
                  }`}
                  onClick={() => {
                    onChange(q.pair_token);
                    setOpen(false);
                  }}
                >
                  <QuoteLogo symbol={q.symbol} logoUrl={q.logo_url} />
                  <span className="font-extrabold">{q.symbol}</span>
                  {q.name ? <span className="truncate text-[12px] font-medium text-fg-subtle">{q.name}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Symbol, quote asset, dev buy, and the collapsed Pons Advanced block.
 * Shared by the wizard's Token chapter and "Launch token later" on My apps.
 */
export function CoinTermsFields({
  terms,
  onChange,
  symbolPlaceholder,
  hd0,
}: {
  terms: CoinTerms;
  onChange: (next: CoinTerms) => void;
  symbolPlaceholder: string;
  hd0: string | null;
}) {
  const quotes = usePonsQuotes();
  const fee = useQuery({ queryKey: ['pons-launch-fee'], queryFn: readLaunchFee, staleTime: 5 * 60_000 });
  const maxTax = useQuery({ queryKey: ['pons-max-tax'], queryFn: readMaxCreatorTaxBps, staleTime: 5 * 60_000 });
  const snipe = useQuery({ queryKey: ['pons-snipe-tax'], queryFn: readSnipeTax, staleTime: 5 * 60_000 });
  const set = <K extends keyof CoinTerms>(k: K, v: CoinTerms[K]) => onChange({ ...terms, [k]: v });
  const quoteSymbol = quoteSymbolFor(quotes.data, terms.pairToken);
  const list = (quotes.data ?? []).filter((q) => q.symbol.toUpperCase() !== 'QQQ');
  const cap = maxTax.data ?? PONS_DEFAULT_MAX_TAX_BPS;
  const taxChips = PONS_TAX_CHIPS.filter((n) => n <= cap);
  const funding = useLaunchFunding(terms, hd0, quoteSymbol);
  const { native, quoteDecimals, devBuyRaw } = funding;

  // Dev-buy preview: the same curve math `launchCoin` uses, against a fresh curve.
  const launchTerms = useQuery({
    queryKey: ['pons-launch-terms', terms.pairToken],
    enabled: !!terms.pairToken,
    queryFn: () => readLaunchTerms(terms.pairToken as Address),
    staleTime: 60_000,
  });
  const devBuyQuote = useMemo(() => {
    if (!launchTerms.data || devBuyRaw == null || devBuyRaw <= 0n) return null;
    return quoteInitialBuy(launchTerms.data, devBuyRaw, terms.creatorTaxBps);
  }, [launchTerms.data, devBuyRaw, terms.creatorTaxBps]);
  const supply = launchTerms.data?.config.supply ?? 0n;
  const devBuyPctOfSupply =
    devBuyQuote && supply > 0n ? Number((devBuyQuote.tokensOut * 10_000n) / supply) / 100 : null;
  const tickerPreview = (terms.symbol.trim() || symbolPlaceholder.trim()).toUpperCase().slice(0, PONS_SYMBOL_MAX) || 'tokens';
  /** What a native Max must leave behind: launch fee + gas. ERC-20 quotes can spend the whole balance. */
  const devBuyMax = (() => {
    const bal = funding.quoteBalance;
    if (bal == null) return null;
    if (!native) return bal;
    const reserve = (fee.data ?? 0n) + LAUNCH_GAS_RESERVE;
    return bal > reserve ? bal - reserve : 0n;
  })();
  const devBuyTooBig = devBuyRaw != null && devBuyMax != null && devBuyRaw > devBuyMax;
  const teamWallets = useMemo(() => parseTeamWallets(terms.teamWallets), [terms.teamWallets]);
  const snipeSeconds = snipe.data?.seconds;
  /** Empty recipient = launch uses the user's wallet. Custom mode = user cleared the default to paste another. */
  const [feeRecipientCustom, setFeeRecipientCustom] = useState(
    () => !!terms.creatorFeeRecipient.trim(),
  );
  const usingYourWallet =
    !feeRecipientCustom && !terms.creatorFeeRecipient.trim() && !!hd0;
  /** Empty symbol = launch uses the suggested ticker from the app name (same as fee-recipient default). */
  const suggested = symbolPlaceholder.trim().toUpperCase().slice(0, PONS_SYMBOL_MAX);
  const [symbolCustom, setSymbolCustom] = useState(() => !!terms.symbol.trim());
  const usingSuggested = !symbolCustom && !terms.symbol.trim() && suggested.length >= 2;

  return (
    <div className="grid gap-5">
      <div>
        <span className="label req">Chain</span>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <button type="button" className="chip" aria-pressed>
            <img src={robinhoodIcon} alt="" className="h-4 w-4 rounded-full object-cover" />
            Robinhood
          </button>
          <button type="button" className="chip" data-soon disabled title="HyperEVM launches come later">
            <img src={hypeIcon} alt="" className="h-4 w-4 rounded-full object-cover" />
            HyperEVM <span className="soon">soon</span>
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          Launch fee{' '}
          <strong className="text-fg">{fee.data != null ? `${formatEther(fee.data)} ETH` : '…'}</strong> from your
          trade wallet on Robinhood Chain.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="block">
          <span className="label req">Symbol</span>
          {usingSuggested ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-stroke-strong bg-fill-weak py-1.5 pl-3.5 pr-1.5 text-[12px] font-bold">
                <span className="truncate font-mono text-[16px] font-extrabold uppercase leading-none tracking-wide">
                  {suggested}
                </span>
                <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-brand">
                  Suggested
                </span>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-fill-hover hover:text-fg"
                  aria-label="Choose a different symbol"
                  title="Remove suggested"
                  onClick={() => {
                    setSymbolCustom(true);
                    set('symbol', '');
                  }}
                >
                  <IconClose size={12} />
                </button>
              </span>
            </div>
          ) : (
            <div className="mt-1.5 grid gap-2">
              <input
                className="field uppercase"
                value={terms.symbol}
                onChange={(e) => {
                  setSymbolCustom(true);
                  set('symbol', e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, PONS_SYMBOL_MAX));
                }}
                placeholder="TICKER"
                maxLength={PONS_SYMBOL_MAX}
                autoCapitalize="characters"
                spellCheck={false}
              />
              {suggested.length >= 2 ? (
                <button
                  type="button"
                  className="w-fit text-[11px] font-bold text-brand hover:underline"
                  onClick={() => {
                    setSymbolCustom(false);
                    set('symbol', '');
                  }}
                >
                  Use suggested ({suggested})
                </button>
              ) : null}
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-fg-subtle">
            {usingSuggested
              ? 'From your app name — this ticker will be used at launch. Remove it to type another.'
              : 'Letters and numbers only. This is locked at launch.'}
          </p>
        </div>
        <div className="block">
          <span className="label req">Quote asset</span>
          <QuoteAssetSelect
            list={list}
            value={terms.pairToken}
            onChange={(pairToken) => set('pairToken', pairToken)}
            loading={quotes.isLoading}
            disabled={quotes.isLoading || list.length === 0}
          />
          <p className="mt-2 text-[11px] text-fg-subtle">
            Only assets the Pons factory approves are shown. Your token is priced, traded and pays you in this
            asset. Fixed at launch.
          </p>
          {quotes.isError ? <p className="mt-1 text-[12px] font-semibold text-error">Could not load quotes.</p> : null}
        </div>
      </div>

      <div className="block max-w-sm">
        <div className="flex items-end justify-between gap-2">
          <span className="label">
            Dev buy <span className="opt">optional · {quoteSymbol}</span>
          </span>
          {hd0 ? (
            <span className="flex items-center gap-1.5 text-[11px] font-bold tabular text-fg-subtle">
              Available:{' '}
              <span className="text-fg">
                {funding.quoteBalance != null ? fmtAmount(funding.quoteBalance, quoteDecimals) : '…'} {quoteSymbol}
              </span>
              {devBuyMax != null && devBuyMax > 0n ? (
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-extrabold text-brand hover:bg-fill-hover"
                  onClick={() => set('devBuy', trimTrailingZeros(formatUnits(devBuyMax, quoteDecimals)))}
                  title={native ? 'Balance minus launch fee and gas' : 'Whole balance'}
                >
                  Max
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="relative mt-1.5">
          <input
            className={`field pr-16 ${devBuyTooBig ? 'border-error' : ''}`}
            value={terms.devBuy}
            onChange={(e) => set('devBuy', e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
            aria-invalid={devBuyTooBig || undefined}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1.5 text-[12px] font-bold text-fg-subtle">
            <QuoteLogo symbol={quoteSymbol} size={14} />
            {quoteSymbol}
          </span>
        </div>
        {devBuyRaw != null && devBuyRaw > 0n ? (
          <p className={`mt-1.5 text-[12px] font-bold tabular ${devBuyTooBig ? 'text-error' : 'text-fg'}`}>
            {devBuyTooBig ? (
              native ? (
                `Not enough ${quoteSymbol} — keep ${fee.data != null ? formatEther(fee.data) : '…'} ETH for the launch fee plus gas.`
              ) : (
                `Not enough ${quoteSymbol} in this wallet.`
              )
            ) : launchTerms.isPending ? (
              'Quoting…'
            ) : devBuyQuote ? (
              <>
                ≈ {fmtAmount(devBuyQuote.tokensOut, 18, 0)} {tickerPreview}
                {devBuyPctOfSupply != null ? (
                  <span className="text-fg-subtle"> · {devBuyPctOfSupply.toFixed(devBuyPctOfSupply < 1 ? 2 : 1)}% of supply</span>
                ) : null}
                {devBuyQuote.refund > 0n ? (
                  <span className="text-fg-subtle">
                    {' '}
                    · buys out the curve; {fmtAmount(devBuyQuote.refund, quoteDecimals)} {quoteSymbol} refunded
                  </span>
                ) : null}
              </>
            ) : launchTerms.isError ? (
              'Could not read the curve terms on Robinhood Chain.'
            ) : null}
          </p>
        ) : null}
        <p className="mt-1.5 text-[11px] text-fg-subtle">
          Your first bag, bought in the same transaction as the launch so nobody can front-run it. Leave 0 to skip.
          {terms.creatorTaxBps > 0 ? ` Estimate already nets out the curve fee and your ${terms.creatorTaxBps / 100}% tax.` : ' Estimate nets out the curve fee.'}
        </p>
      </div>

      <div className="rounded-xl border-2 border-stroke-weak">
        <button
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-left"
          onClick={() => set('advancedOpen', !terms.advancedOpen)}
          aria-expanded={terms.advancedOpen}
        >
          <span className="text-[13px] font-extrabold">Advanced</span>
          <span className="flex items-center gap-2 text-[11px] font-bold text-fg-subtle">
            {terms.creatorTaxBps / 100}% tax · buyback {terms.buybackEnabled ? 'on' : 'off'}
            {teamWallets.valid.length ? ` · ${teamWallets.valid.length} team` : ''}
            <IconChevron size={14} className={terms.advancedOpen ? 'rotate-180' : ''} />
          </span>
        </button>
        {terms.advancedOpen ? (
          <div className="grid gap-4 border-t border-stroke-weak px-4 py-4">
            <div>
              <span className="label">
                Creator tax <span className="opt">Pons v2 · max {cap / 100}%</span>
              </span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {taxChips.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="chip"
                    aria-pressed={terms.creatorTaxBps === n}
                    onClick={() => set('creatorTaxBps', n)}
                  >
                    {n / 100}%
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-fg-subtle">
                Extra cut on every trade, on top of the curve fee, paid to you in full. Locked at launch.
              </p>
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-background px-3 py-2.5">
              <span>
                <span className="block text-[13px] font-bold">Buybacks</span>
                <span className="text-[11px] text-fg-subtle">A slice of your fee buys the token back and vests over five years.</span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--text-brand)]"
                checked={terms.buybackEnabled}
                onChange={(e) => set('buybackEnabled', e.target.checked)}
              />
            </label>
            <div>
              <span className="label">
                Creator fees recipient{' '}
              </span>
              {usingYourWallet ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-stroke-strong bg-fill-weak py-1.5 pl-3 pr-1.5 text-[12px] font-bold">
                    <span className="truncate font-mono">{shortAddr(hd0!)}</span>
                    <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-brand">
                      Your wallet
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-fill-hover hover:text-fg"
                      aria-label="Use a different fee recipient"
                      title="Remove default"
                      onClick={() => {
                        setFeeRecipientCustom(true);
                        set('creatorFeeRecipient', '');
                      }}
                    >
                      <IconClose size={12} />
                    </button>
                  </span>
                </div>
              ) : (
                <div className="mt-1.5 grid gap-2">
                  <input
                    className="field font-mono text-[13px]"
                    value={terms.creatorFeeRecipient}
                    onChange={(e) => {
                      setFeeRecipientCustom(true);
                      set('creatorFeeRecipient', e.target.value.replace(/[^0-9a-fxA-FX]/g, ''));
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                  />
                  {hd0 ? (
                    <button
                      type="button"
                      className="w-fit text-[11px] font-bold text-brand hover:underline"
                      onClick={() => {
                        setFeeRecipientCustom(false);
                        set('creatorFeeRecipient', '');
                      }}
                    >
                      Use your wallet ({shortAddr(hd0)})
                    </button>
                  ) : null}
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-fg-subtle">
                {usingYourWallet
                  ? 'Creator fees go to your wallet. Remove it only if you want a different address.'
                  : 'Paste a 0x address for fees, or restore your wallet. Left blank, fees still go to your wallet — never to nobody.'}
              </p>
            </div>
            <div>
              <span className="label">
                Team wallets{' '}
                <span className="opt">
                  optional · snipe-tax exempt · max {MAX_SNIPE_TAX_EXEMPTIONS}
                </span>
              </span>
              <textarea
                className={`field mt-1.5 min-h-[72px] font-mono text-[12px] ${teamWallets.invalid.length ? 'border-error' : ''}`}
                value={terms.teamWallets}
                onChange={(e) => set('teamWallets', e.target.value)}
                placeholder={'0x… one per line'}
                spellCheck={false}
              />
              <p className="mt-1.5 text-[11px] text-fg-subtle">
                For the first {snipeSeconds != null ? `${snipeSeconds} seconds` : 'seconds'} after launch, buys pay an
                anti-snipe tax that starts at{' '}
                {snipe.data ? `${snipe.data.startBps / 100}%` : '99%'} and decays to zero. Your wallet and the fee
                recipient are already exempt. Add co-founder or treasury wallets that will buy in that window.
                {teamWallets.valid.length ? ` ${teamWallets.valid.length} address${teamWallets.valid.length === 1 ? '' : 'es'} ready.` : ''}
              </p>
              {teamWallets.invalid.length ? (
                <p className="mt-1 text-[12px] font-semibold text-error">
                  Not an address: {teamWallets.invalid.slice(0, 3).join(', ')}
                  {teamWallets.invalid.length > 3 ? ` +${teamWallets.invalid.length - 3}` : ''}
                </p>
              ) : null}
              {teamWallets.valid.length > MAX_SNIPE_TAX_EXEMPTIONS ? (
                <p className="mt-1 text-[12px] font-semibold text-error">
                  Only the first {MAX_SNIPE_TAX_EXEMPTIONS} will be sent.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
