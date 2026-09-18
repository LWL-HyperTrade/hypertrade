import { useEffect, useMemo, useState } from 'react';
import { useSendTransaction } from '@privy-io/react-auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { useWebAuth } from '../lib/auth';
import { ensureRobinhoodWallet } from '../lib/robinhoodWithdraw';
import { formatCompactCount, formatCompactUsd, formatUsdPrice } from '../lib/earnings';
import { isWalletUserRejectedRequest } from '../lib/hlTrade';
import {
  buyOnCurve,
  minOut,
  quoteBuy,
  quoteSell,
  readCurveTicket,
  readTradeBalances,
  ROBINHOOD_CHAIN_ID,
  geckoTokenUrl,
  robinhoodTokenUrl,
  robinhoodTxUrl,
  sellOnCurve,
  type TradeStep,
} from '../lib/pons';
import type { CoinMarket } from '../lib/pons/market';
import { fetchCurveTradeCount, formatGraduationPct, graduationBarWidth } from '../lib/pons/market';
import { quoteLogoSrc } from '../lib/quoteLogos';
import type { TenantCoin, TenantPublic } from '../lib/tenants';
import { CopyCa } from './CreatorAppCard';
import { IconExternal, IconSwap } from './icons';
import { TradeToast, type TradeToastPayload } from './terminal/TradeToast';
import robinhoodIcon from '../assets/images/robinhood-icon.webp';

const STEP_COPY: Record<TradeStep, string> = {
  switching: 'Switching to Robinhood Chain…',
  approving: 'Approve in the wallet popup…',
  preparing: 'Checking the trade on-chain…',
  sending: 'Confirm in the wallet popup…',
  confirming: 'Waiting for confirmation…',
  done: 'Done',
};

const PCTS = [25, 50, 75, 100] as const;
const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH left for gas on a native max buy.
/** Slippage presets in bps. 1% matches the Pons ticket default. */
const SLIPPAGE_PRESETS = [50, 100, 300, 500] as const;
const SLIPPAGE_DEFAULT_BPS = 100;
const SLIPPAGE_MAX_BPS = 4_900;

function slippageLabel(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(pct < 1 ? 2 : 1).replace(/\.?0+$/, '')}%`;
}

function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!t || t === '.') return 0n;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

function formatAmt(raw: bigint, decimals: number): string {
  const v = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(v) || v === 0) return '0';
  if (v >= 1_000_000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatRaised(raw: bigint, decimals: number): string {
  const v = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(v) || v === 0) return '0';
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fromBalance(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  const [w, f = ''] = s.split('.');
  if (!f) return w;
  const cut = f.slice(0, Math.min(decimals, 8)).replace(/0+$/, '');
  return cut ? `${w}.${cut}` : w;
}

export function TokenTradeCard({
  tenant,
  market,
  embedded,
}: {
  tenant: TenantPublic;
  market?: CoinMarket;
  /** Inside the creator Token section: identity + CA already shown beside it. */
  embedded?: boolean;
}) {
  const coin = tenant.coin;
  if (!coin) return null;
  return <TokenTradeBody tenant={tenant} coin={coin} market={market} embedded={embedded} />;
}

function TokenTradeBody({
  tenant,
  coin,
  market,
  embedded,
}: {
  tenant: TenantPublic;
  coin: TenantCoin;
  market?: CoinMarket;
  embedded?: boolean;
}) {
  const {
    authenticated,
    address,
    login,
    getEthereumProvider,
    switchTradeChain,
  } = useWebAuth();
  const { sendTransaction } = useSendTransaction();
  const qc = useQueryClient();
  const symbol = (coin.symbol || '').toUpperCase();
  const [buying, setBuying] = useState(true);
  const [fromText, setFromText] = useState('');
  const [step, setStep] = useState<TradeStep | 'idle'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [toast, setToast] = useState<TradeToastPayload | null>(null);
  const [slippageBps, setSlippageBps] = useState<number>(SLIPPAGE_DEFAULT_BPS);
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [slippageText, setSlippageText] = useState('');

  const ticketQ = useQuery({
    queryKey: ['pons-ticket', coin.token],
    queryFn: () => readCurveTicket(coin.token as Address),
    refetchInterval: 12_000,
  });
  const ticket = ticketQ.data;
  const balQ = useQuery({
    queryKey: ['pons-balances', coin.token, address],
    enabled: !!address && !!ticket,
    queryFn: () =>
      readTradeBalances({
        account: address as Address,
        token: ticket!.token,
        pairToken: ticket!.pairToken,
        native: ticket!.native,
      }),
    refetchInterval: 12_000,
  });
  const tradesQ = useQuery({
    queryKey: ['pons-trades', coin.token, ticket?.curve],
    enabled: !!ticket?.curve && market?.source !== 'dex',
    queryFn: () => fetchCurveTradeCount({ ...coin, curve: ticket!.curve }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const tradeCount = market?.source === 'dex' ? (market.trades ?? null) : (tradesQ.data ?? null);

  const quoteDec = ticket?.quoteDecimals ?? 18;
  const tokenDec = ticket?.tokenDecimals ?? 18;
  const quoteSym = ticket?.quoteSymbol ?? 'ETH';
  const fromDec = buying ? quoteDec : tokenDec;
  const fromRaw = parseAmount(fromText, fromDec);
  const recipient = (address || '0x0000000000000000000000000000000000000001') as Address;

  const quoteQ = useQuery({
    queryKey: ['pons-quote', coin.token, buying, fromText, recipient],
    enabled: !!ticket && fromRaw != null && fromRaw > 0n && ticket.phase === 0,
    queryFn: async () => {
      if (!ticket || fromRaw == null || fromRaw <= 0n) return null;
      if (buying) return quoteBuy(ticket.curve, fromRaw, recipient);
      return quoteSell(ticket.curve, fromRaw);
    },
    staleTime: 2_000,
  });

  const tokensOut = quoteQ.data && 'tokensOut' in quoteQ.data ? quoteQ.data.tokensOut : 0n;
  const quoteOut = quoteQ.data && 'quoteOut' in quoteQ.data ? quoteQ.data.quoteOut : 0n;
  const toRaw = buying ? tokensOut : quoteOut;
  const toDec = buying ? tokenDec : quoteDec;
  const toSym = buying ? symbol : quoteSym;

  const quoteAvail = balQ.data?.quote ?? 0n;
  const tokenAvail = balQ.data?.token ?? 0n;
  const fromAvail = buying ? quoteAvail : tokenAvail;
  const toAvail = buying ? tokenAvail : quoteAvail;

  const curveOpen = !ticket || (ticket.phase === 0 && !ticket.graduated);
  const buyClosed = !curveOpen || (ticket?.sellable ?? 0n) === 0n;
  const sellClosed = !curveOpen || !!ticket?.readyToGraduate;
  const sideClosed = buying ? buyClosed : sellClosed;
  const busy = step !== 'idle' && step !== 'done';
  const pct =
    ticket && ticket.threshold > 0n
      ? Math.max(0, Math.min(100, Number((ticket.raised * 10000n) / ticket.threshold) / 100))
      : 0;

  const canSubmit =
    curveOpen &&
    !sideClosed &&
    !busy &&
    fromRaw != null &&
    fromRaw > 0n &&
    toRaw > 0n &&
    fromRaw <= fromAvail;

  useEffect(() => {
    setError(null);
    setTxHash(null);
  }, [buying, fromText]);

  const sendTx = async (tx: {
    to: Address;
    data: Hex;
    value: bigint;
    gasLimit?: number;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    title: string;
    description: string;
  }) => {
    if (!address) throw new Error('Wallet is not ready');
    const { hash } = await sendTransaction(
      {
        to: tx.to,
        data: tx.data,
        from: address,
        value: tx.value > 0n ? tx.value.toString() : undefined,
        chainId: ROBINHOOD_CHAIN_ID,
        ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
        ...(tx.maxFeePerGas != null ? { maxFeePerGas: tx.maxFeePerGas.toString() } : {}),
        ...(tx.maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString() } : {}),
      },
      {
        address,
        uiOptions: {
          showWalletUIs: true,
          description: tx.description,
          buttonText: 'Approve',
          transactionInfo: { title: tx.title, action: buying ? 'Buy token' : 'Sell token' },
        },
      },
    );
    return hash;
  };

  const submit = async () => {
    if (!authenticated) {
      login();
      return;
    }
    if (!ticket || !address || fromRaw == null || fromRaw <= 0n) return;
    setError(null);
    setTxHash(null);
    setStep('switching');
    try {
      const provider = await ensureRobinhoodWallet({
        switchChain: switchTradeChain,
        getProvider: getEthereumProvider,
      });
      const hash = buying
        ? await buyOnCurve({
            hd0: address as Address,
            sendTx,
            switchChain: switchTradeChain,
            provider,
            onStep: setStep,
            curve: ticket.curve,
            pairToken: ticket.pairToken,
            quoteIn: fromRaw,
            minTokensOut: minOut(tokensOut, BigInt(slippageBps)),
            native: ticket.native,
            symbol,
          })
        : await sellOnCurve({
            hd0: address as Address,
            sendTx,
            switchChain: switchTradeChain,
            provider,
            onStep: setStep,
            curve: ticket.curve,
            token: ticket.token,
            tokensIn: fromRaw,
            minQuoteOut: minOut(quoteOut, BigInt(slippageBps)),
            symbol,
          });
      setTxHash(hash);
      // Snapshot before clearing the field so the toast can say what happened.
      const soldOrSpent = `${formatAmt(fromRaw, fromDec)} ${buying ? quoteSym : symbol}`;
      const got = `${formatAmt(toRaw, toDec)} ${buying ? symbol : quoteSym}`;
      setToast({
        kind: 'ok',
        message: buying ? `Bought ≈ ${got} for ${soldOrSpent}.` : `Sold ${soldOrSpent} for ≈ ${got}.`,
      });
      setFromText('');
      void qc.invalidateQueries({ queryKey: ['pons-ticket', coin.token] });
      void qc.invalidateQueries({ queryKey: ['pons-balances', coin.token] });
      void qc.invalidateQueries({ queryKey: ['pons-trades', coin.token] });
      void qc.invalidateQueries({ queryKey: ['pons-activity', coin.token] });
      void qc.invalidateQueries({ queryKey: ['coin-markets'] });
    } catch (e) {
      const msg = isWalletUserRejectedRequest(e)
        ? 'Wallet request was rejected.'
        : e instanceof Error
          ? e.message
          : 'Trade failed';
      setError(msg);
      if (!isWalletUserRejectedRequest(e)) setToast({ kind: 'err', message: msg });
    } finally {
      setStep('idle');
    }
  };

  const setPct = (n: number) => {
    let cap = fromAvail;
    if (buying && ticket?.native && cap > GAS_RESERVE) cap = cap - GAS_RESERVE;
    const raw = (cap * BigInt(n)) / 100n;
    // Max must be the exact balance (full decimals) so a sell empties the wallet — no dust.
    setFromText(n === 100 ? formatUnits(raw, fromDec) : fromBalance(raw, fromDec));
  };

  const applySlippageText = (s: string) => {
    setSlippageText(s);
    const v = Number(s.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) return;
    const bps = Math.round(v * 100);
    if (bps >= 1 && bps <= SLIPPAGE_MAX_BPS) setSlippageBps(bps);
  };
  const slippageCustom = !SLIPPAGE_PRESETS.includes(slippageBps as (typeof SLIPPAGE_PRESETS)[number]);

  const quoteLogo = quoteLogoSrc(quoteSym);
  const fromUsd = useMemo(() => {
    if (!market?.priceUsd || fromRaw == null || fromRaw <= 0n) return null;
    if (buying) return null;
    return Number(formatUnits(fromRaw, tokenDec)) * market.priceUsd;
  }, [buying, fromRaw, market?.priceUsd, tokenDec]);
  const toUsd = useMemo(() => {
    if (!market?.priceUsd || toRaw <= 0n) return null;
    if (!buying) return null;
    return Number(formatUnits(toRaw, tokenDec)) * market.priceUsd;
  }, [buying, toRaw, market?.priceUsd, tokenDec]);

  const cta = !authenticated
    ? 'Sign in to trade'
    : busy
      ? STEP_COPY[step as TradeStep]
      : !curveOpen
        ? 'Graduated'
        : sideClosed
          ? buying
            ? 'Curve closed'
            : 'Sells closed'
          : buying
            ? `Buy ${symbol}`
            : `Sell ${symbol}`;

  return (
    <div className="card-pop overflow-hidden">
      <div className="mx-3 mb-3 mt-3 rounded-xl border border-stroke-weak bg-sunken/70 p-3">
        {embedded ? (
          <div className="flex items-center justify-between gap-2">
            <div className="text-[15px] font-extrabold">
              {buying ? 'Buy' : 'Sell'} <span className="font-mono text-brand">${symbol}</span>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full border border-stroke-weak bg-fill-weak px-1.5 py-0.5 text-[10px] font-extrabold text-fg-muted">
              {quoteLogo ? <img src={quoteLogo} alt="" className="h-3 w-3 rounded-full" /> : null}
              Paired {quoteSym}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2.5">
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-black text-black">
                {(symbol || tenant.app_name).slice(0, 1)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-extrabold">Buy {tenant.app_name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {symbol ? (
                  <span className="font-mono text-[12px] font-bold text-fg">${symbol}</span>
                ) : null}
                <span className="inline-flex items-center gap-1 rounded-full border border-stroke-weak bg-fill-weak px-1.5 py-0.5 text-[10px] font-extrabold text-fg-muted">
                  {quoteLogo ? <img src={quoteLogo} alt="" className="h-3 w-3 rounded-full" /> : null}
                  Paired {quoteSym}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Mini label="Price" value={formatUsdPrice(market?.priceUsd)} />
          <Mini label="Mcap" value={market?.mcapUsd != null ? formatCompactUsd(market.mcapUsd) : '—'} />
          <Mini
            label="Trades"
            value={tradeCount != null ? formatCompactCount(tradeCount) : '—'}
          />
        </div>

        {embedded ? null : (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-bold text-fg-subtle">
            <CopyCa value={coin.token} />
            <a href={market?.explorerUrl ?? robinhoodTokenUrl(coin.token)} target="_blank" rel="noreferrer" title="Robinhood Chain">
              <img src={robinhoodIcon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" />
            </a>
            <a href={geckoTokenUrl(coin.token)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-brand">
              GeckoTerminal <IconExternal size={11} />
            </a>
          </div>
        )}

        <div className="mt-3 rounded-xl border border-stroke-weak bg-fill-weaker px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[12px] font-extrabold">
            <span>Bonding curve</span>
            <span className="tabular text-fg-muted">{formatGraduationPct(pct)} to graduation</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-fill-weak">
            <div className="h-full rounded-full bg-brand" style={{ width: `${graduationBarWidth(pct)}%` }} />
          </div>
          <p className="mt-2 text-[11px] leading-5 text-fg-muted">
            {ticket
              ? `${formatRaised(ticket.raised, quoteDec)} of ${formatRaised(ticket.threshold, quoteDec)} ${quoteSym} raised.`
              : 'Reading the curve…'}
          </p>
        </div>

        {curveOpen ? (
          <>
            <SwapField
              label="Selling"
              amount={fromText}
              onChange={setFromText}
              usd={fromUsd}
              symbol={buying ? quoteSym : symbol}
              logo={buying ? quoteLogo : tenant.logo_url}
              available={fromAvail}
              decimals={fromDec}
              onMax={address && fromAvail > 0n ? () => setPct(100) : undefined}
              maxHint={buying && ticket?.native ? 'Balance minus 0.0003 ETH kept for gas' : 'Whole balance'}
            />
            <div className="relative z-10 -my-2.5 flex justify-center">
              <button
                type="button"
                aria-label="Switch buy and sell"
                onClick={() => {
                  setBuying((v) => !v);
                  setFromText('');
                }}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-stroke-weak bg-overlay text-fg hover:bg-fill-hover"
              >
                <IconSwap size={15} />
              </button>
            </div>
            <SwapField
              label="Buy"
              amount={fromRaw != null && fromRaw > 0n ? formatAmt(toRaw, toDec) : '0'}
              usd={toUsd}
              symbol={toSym}
              logo={buying ? tenant.logo_url : quoteLogo}
              available={toAvail}
              decimals={toDec}
              readOnly
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex gap-1">
                {PCTS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={!address || fromAvail <= 0n}
                    onClick={() => setPct(n)}
                    className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold disabled:opacity-40 ${
                      n === 100
                        ? 'border-brand/50 text-brand hover:bg-brand-soft'
                        : 'border-stroke-weak text-fg-subtle hover:bg-fill-hover hover:text-fg'
                    }`}
                  >
                    {n === 100 ? 'Max' : `${n}%`}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSlippageOpen((v) => !v)}
                aria-expanded={slippageOpen}
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold hover:bg-fill-hover hover:text-fg ${
                  slippageBps > 500 ? 'text-warning' : 'text-fg-subtle'
                }`}
                title="Max price move you accept before the trade reverts"
              >
                Slippage {slippageLabel(slippageBps)}
              </button>
            </div>
            {slippageOpen ? (
              <div className="mt-2 flex flex-wrap items-center gap-1 rounded-xl border border-stroke-weak bg-fill-weaker px-2 py-1.5">
                {SLIPPAGE_PRESETS.map((bps) => (
                  <button
                    key={bps}
                    type="button"
                    aria-pressed={slippageBps === bps}
                    onClick={() => {
                      setSlippageBps(bps);
                      setSlippageText('');
                    }}
                    className={`rounded-md px-2 py-1 text-[11px] font-extrabold ${
                      slippageBps === bps ? 'bg-brand text-black' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
                    }`}
                  >
                    {slippageLabel(bps)}
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-1 text-[11px] font-bold text-fg-subtle">
                  <input
                    inputMode="decimal"
                    placeholder={slippageCustom ? slippageLabel(slippageBps).replace('%', '') : 'Custom'}
                    value={slippageText}
                    onChange={(e) => applySlippageText(e.target.value.replace(/[^0-9.,]/g, '').slice(0, 5))}
                    className={`w-16 rounded-md border bg-background px-1.5 py-1 text-right text-[11px] font-extrabold tabular text-fg outline-none focus:border-brand ${
                      slippageCustom ? 'border-brand' : 'border-stroke-weak'
                    }`}
                  />
                  %
                </label>
                {slippageBps > 500 ? (
                  <p className="w-full text-[10px] font-semibold text-warning">
                    High slippage — you may receive noticeably less than quoted.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-stroke-weak px-3 py-4 text-center">
            <p className="text-[12px] leading-5 text-fg-muted">
              {ticket?.phase === 1
                ? 'Graduation is finishing. The curve is closed — GeckoTerminal once the pool is up.'
                : 'This launch graduated. Liquidity is on Uniswap v4 — open GeckoTerminal to trade.'}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 px-3 pb-4">
        {ticket && !curveOpen ? (
          <a href={geckoTokenUrl(coin.token)} target="_blank" rel="noreferrer" className="btn-hype w-full py-2.5 text-sm">
            Trade on GeckoTerminal <IconExternal size={15} />
          </a>
        ) : (
          <button
            type="button"
            className="btn-hype w-full py-2.5 text-sm"
            disabled={authenticated && (busy || !canSubmit)}
            onClick={() => void submit()}
          >
            {cta}
          </button>
        )}
        {ticketQ.isError ? (
          <p className="text-[12px] leading-5 text-error">
            Could not read this curve on Robinhood Chain. Retry in a moment.
          </p>
        ) : null}
        {authenticated && fromRaw != null && fromRaw > fromAvail ? (
          <p className="text-[12px] leading-5 text-error">
            Not enough {buying ? quoteSym : symbol} in this wallet.
          </p>
        ) : null}
        {error ? <p className="text-[12px] leading-5 text-error">{error}</p> : null}
        {txHash ? (
          <a
            href={robinhoodTxUrl(txHash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-1 text-[12px] font-bold text-brand"
          >
            Trade confirmed <IconExternal size={12} />
          </a>
        ) : null}
      </div>
      <TradeToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function Mini({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-fg-subtle">{label}</div>
      <div className="mt-0.5 truncate text-[12px] font-black tabular text-fg">{value}</div>
    </div>
  );
}

function SwapField({
  label,
  amount,
  onChange,
  usd,
  symbol,
  logo,
  available,
  decimals,
  readOnly,
  onMax,
  maxHint,
}: {
  label: string;
  amount: string;
  onChange?: (v: string) => void;
  usd: number | null;
  symbol: string;
  logo?: string | null;
  available: bigint;
  decimals: number;
  readOnly?: boolean;
  /** When set, the "available" line becomes a Max button. */
  onMax?: () => void;
  maxHint?: string;
}) {
  return (
    <div className="mt-2 rounded-xl border border-stroke-weak bg-fill-weaker px-3 py-2.5">
      <div className="text-[11px] font-extrabold text-fg-muted">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          {readOnly ? (
            <div className="truncate text-2xl font-black tabular leading-none">{amount || '0'}</div>
          ) : (
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              className="w-full bg-transparent text-2xl font-black tabular leading-none text-fg outline-none placeholder:text-fg-subtle"
            />
          )}
          <div className="mt-1 text-[11px] font-bold tabular text-fg-subtle">
            {usd != null && Number.isFinite(usd) ? formatUsdPrice(usd) : '$0.00'}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-stroke-weak bg-overlay px-2 py-1 text-[12px] font-extrabold">
            {logo ? <img src={logo} alt="" className="h-4 w-4 rounded-full object-cover" /> : null}
            {symbol}
          </span>
          {onMax ? (
            <button
              type="button"
              onClick={onMax}
              title={maxHint}
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] font-semibold tabular text-fg-subtle hover:bg-fill-hover hover:text-fg"
            >
              {formatAmt(available, decimals)} available
              <span className="rounded bg-brand-soft px-1 text-[9px] font-extrabold uppercase tracking-wide text-brand">
                Max
              </span>
            </button>
          ) : (
            <span className="text-[10px] font-semibold tabular text-fg-subtle">
              {formatAmt(available, decimals)} available
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
