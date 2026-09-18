import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssetRow } from '../../lib/tenants';
import { catalogAllows } from './catalogMatch';
import {
  fetchAllMids,
  estimatePositionOpenedAt,
  fetchHistoricalOrders,
  fetchMidsForCoins,
  fetchUserFills,
  displaySymbol,
  formatPx,
  formatSz,
  formatUsd,
  isEditableOpenOrder,
  midFor,
  num,
  type Clearinghouse,
  type HistoricalOrder,
  type OpenOrder,
  type SpotBalance,
  type UserFill,
} from '../../lib/hlMarket';
import { IconApp, IconCash, IconCheck, IconChevron, IconCopy, IconExternal, IconWallet } from '../icons';
import { shortAddr } from '../../lib/tenants';
import { ScrollFadeX } from '../ScrollFadeX';
import { useWebAuth } from '../../lib/auth';
import { consoleHref } from '../../lib/config';
import { useHlSetupStatus } from '../../lib/useHlAutoSetup';
import { SPOT_DUST_USD } from '../../lib/tradePrefs';
import { formatEarnedUsd } from '../../lib/earnings';
import { ARBITRUM_CHAIN_ID } from '../../lib/arbUsdc';
import {
  claimHlRewards,
  fetchHlRewards,
  HL_CLAIM_MIN_USD,
  HL_WITHDRAW_FEE_USDC,
  MIN_HL_WITHDRAW_USDC,
  isWalletUserRejectedRequest,
  sendPerpUsdc,
  sendSpotToken,
  transferUsdSpotPerp,
  withdrawFromHyperliquid,
  type Hex,
} from '../../lib/hlTrade';

type Tab = 'positions' | 'orders' | 'history' | 'trades' | 'balances' | 'builder';
type Position = Clearinghouse['positions'][number];

type Props = {
  address: string | null;
  catalog: string[];
  assets: AssetRow[];
  clearing: Clearinghouse | null;
  orders: OpenOrder[];
  /** Prefer live mark for the active terminal market. */
  liveMarkCoin?: string | null;
  liveMarkPx?: number | null;
  /** Active terminal market — hide the ticker chevron when this row is already open. */
  selectedCoin?: string | null;
  /**
   * Canonical listed coin for a position ticker, or null if this desk does not
   * list it (HIP-3 `dex:coin`, future HIP-4 ids, etc.).
   */
  resolveMarketCoin?: (coin: string) => string | null;
  /** Jump the desk to this position's ticker (same as the mobile portfolio chevron). */
  onSelectMarket?: (coin: string) => void;
  canTrade?: boolean;
  closingCoin?: string | null;
  closeError?: string | null;
  onClosePosition?: (position: Position) => void;
  /** When false, Close skips the Confirm step. */
  confirmClose?: boolean;
  onOpenTpsl?: (position: Position, markPx: number) => void;
  onSharePnl?: (payload: {
    coin: string;
    direction: 'LONG' | 'SHORT';
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
    leverage?: number | null;
  }) => void;
  cancellingOid?: number | null;
  cancelError?: string | null;
  onCancelOrder?: (order: OpenOrder) => void;
  onEditOrder?: (order: OpenOrder) => void;
  /** Hide spot tokens worth under $0.10. Default on. */
  spotDusting?: boolean;
  /** HD 1 — only for the signed-in owner of this app. */
  builderAddress?: string | null;
  builderClearing?: Clearinghouse | null;
  tenantBuilderAddress?: string | null;
  appName?: string | null;
};

export function AccountDock({
  address,
  catalog,
  assets,
  clearing,
  orders,
  liveMarkCoin,
  liveMarkPx,
  selectedCoin = null,
  resolveMarketCoin,
  onSelectMarket,
  canTrade,
  closingCoin,
  closeError,
  onClosePosition,
  confirmClose = true,
  onOpenTpsl,
  onSharePnl,
  cancellingOid,
  cancelError,
  onCancelOrder,
  onEditOrder,
  spotDusting = true,
  builderAddress = null,
  builderClearing = null,
  tenantBuilderAddress = null,
  appName = null,
}: Props) {
  const { authenticated, address: authAddress, getEthereumProvider, getBuilderEthereumProvider, switchBuilderChain } =
    useWebAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('positions');
  const [confirmCoin, setConfirmCoin] = useState<string | null>(null);
  const [confirmOid, setConfirmOid] = useState<number | null>(null);
  const positions = (clearing?.positions ?? []).filter((p) => catalogAllows(catalog, p.coin, assets));
  const open = orders.filter((o) => catalogAllows(catalog, o.coin, assets));

  const positionCoinsKey = positions
    .map((p) => p.coin)
    .sort()
    .join('|');

  const liveMidsQ = useQuery({
    queryKey: ['hl', 'positionMids', positionCoinsKey],
    enabled: positions.length > 0,
    queryFn: () => fetchMidsForCoins(positions.map((p) => p.coin)),
    refetchInterval: 2_000,
    staleTime: 1_000,
  });

  const markByCoin = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) {
      const px = num(a.markPx);
      if (px != null && px > 0) m.set(a.coin, px);
    }
    const live = liveMidsQ.data;
    if (live) {
      for (const [coin, px] of live) {
        if (px > 0) m.set(coin, px);
      }
    }
    if (liveMarkCoin && liveMarkPx != null && liveMarkPx > 0) {
      m.set(liveMarkCoin, liveMarkPx);
    }
    return m;
  }, [assets, liveMidsQ.data, liveMarkCoin, liveMarkPx]);

  const fillsQ = useQuery({
    queryKey: ['hl', 'userFills', address],
    // Prefetch whenever we have an address so Live Positions Time updates
    // without waiting for a tab switch / full page refresh.
    enabled: !!address,
    queryFn: () => fetchUserFills(address!),
    staleTime: 8_000,
    refetchInterval: positions.length > 0 ? 12_000 : false,
  });
  const histQ = useQuery({
    queryKey: ['hl', 'historicalOrders', address],
    enabled: !!address && tab === 'history',
    queryFn: () => fetchHistoricalOrders(address!),
    staleTime: 15_000,
  });

  const fills = (fillsQ.data ?? []).filter((f) => catalogAllows(catalog, f.coin, assets));
  const history = (histQ.data ?? []).filter((o) => catalogAllows(catalog, o.coin, assets));

  const openedAtByCoin = useMemo(() => {
    const m = new Map<string, number>();
    const allFills = fillsQ.data ?? [];
    for (const p of positions) {
      const t = estimatePositionOpenedAt(allFills, p.coin);
      if (t != null) m.set(p.coin, t);
    }
    return m;
  }, [fillsQ.data, positionCoinsKey, positions]);

  const extraSpot = (clearing?.spotBalances ?? []).filter((b) => b.coin.toUpperCase() !== 'USDC').length;
  const pooledAccount =
    clearing?.abstractionMode === 'unifiedAccount' || clearing?.abstractionMode === 'portfolioMargin';
  const usdcRows = address ? (pooledAccount || clearing?.abstractionMode == null ? 1 : 2) : 0;
  const portfolioN = address ? usdcRows + extraSpot : 0;
  const builderSpot = (builderClearing?.spotBalances ?? []).filter((b) => b.coin.toUpperCase() !== 'USDC').length;
  const builderN = builderAddress ? 2 + builderSpot : 0;
  const showBuilderTab = !!builderAddress;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'positions', label: `Live Positions (${positions.length})` },
    { id: 'orders', label: `Open Orders (${open.length})` },
    { id: 'history', label: 'Order History' },
    { id: 'trades', label: 'Trade History' },
    { id: 'balances', label: portfolioN ? `Portfolio (${portfolioN})` : 'Portfolio' },
    ...(showBuilderTab
      ? [{ id: 'builder' as const, label: builderN ? `My Builder Wallet (${builderN})` : 'My Builder Wallet' }]
      : []),
  ];
  const headerClearing = tab === 'builder' ? builderClearing : clearing;
  const projectsHref = showBuilderTab ? consoleHref('/apps') : null;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-stroke-weak bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-stroke-weak px-3">
        <ScrollFadeX className="min-w-0 flex-1" fadeFrom="var(--bg-base)">
          <div className="flex items-center gap-1 pr-6">
            {tabs.map(({ id, label }) => (
              <span key={id} className="flex shrink-0 items-center">
                {id === 'builder' ? (
                  <span className="mx-1 h-4 w-px shrink-0 bg-stroke-strong" aria-hidden />
                ) : null}
                <button
                  type="button"
                  onClick={() => setTab(id)}
                  className={`shrink-0 px-3 py-2.5 text-[12px] font-bold ${
                    tab === id
                      ? id === 'balances'
                        ? 'border-b-2 border-market-up text-fg'
                        : id === 'builder'
                          ? 'border-b-2 border-brand text-fg'
                          : 'border-b-2 border-brand text-fg'
                      : 'border-b-2 border-transparent text-fg-subtle hover:text-fg'
                  }`}
                >
                  {id === 'balances' ? (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-extrabold ${
                        tab === id ? 'bg-market-up text-black' : 'bg-market-up/25 text-market-up'
                      }`}
                    >
                      <IconWallet size={13} />
                      {label}
                    </span>
                  ) : id === 'builder' ? (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-extrabold ${
                        tab === id ? 'bg-brand text-[#06140c]' : 'bg-brand/20 text-brand'
                      }`}
                    >
                      <IconCash size={13} />
                      {label}
                    </span>
                  ) : (
                    label
                  )}
                </button>
                {id === 'builder' && projectsHref ? (
                  <a
                    href={projectsHref}
                    className="shrink-0 border-b-2 border-transparent py-2.5 pl-0.5 pr-2 text-[12px] font-bold text-fg-subtle hover:text-fg"
                  >
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-brand/20 px-2 py-0.5 font-extrabold text-brand hover:bg-brand/30">
                      <IconApp size={13} />
                      My Builder Projects
                    </span>
                  </a>
                ) : null}
              </span>
            ))}
          </div>
        </ScrollFadeX>
        <div className="hidden shrink-0 tabular text-[11px] text-fg-muted sm:block">
          Equity {formatUsd(headerClearing?.accountValue)} · Margin {formatUsd(headerClearing?.totalMarginUsed)}
        </div>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-auto">
        {!address ? (
          <p className="px-3 py-4 text-[12px] text-fg-subtle">Sign in to see positions for this wallet.</p>
        ) : tab === 'positions' ? (
          <>
            <PositionsTable
              positions={positions}
              markByCoin={markByCoin}
              openedAtByCoin={openedAtByCoin}
              selectedCoin={selectedCoin}
              resolveMarketCoin={resolveMarketCoin}
              onSelectMarket={onSelectMarket}
              canTrade={!!canTrade && !!onClosePosition}
              closingCoin={closingCoin ?? null}
              confirmCoin={confirmCoin}
              confirmClose={confirmClose}
              onAskClose={(coin) => {
                if (!coin) {
                  setConfirmCoin(null);
                  return;
                }
                if (!confirmClose) {
                  const p = positions.find((row) => row.coin === coin);
                  if (p) onClosePosition?.(p);
                  return;
                }
                setConfirmCoin(coin);
              }}
              onConfirmClose={(p) => {
                setConfirmCoin(null);
                onClosePosition?.(p);
              }}
              onOpenTpsl={onOpenTpsl}
              onSharePnl={onSharePnl}
            />
            {closeError ? <p className="px-3 pb-2 text-[11px] text-market-down">{closeError}</p> : null}
          </>
        ) : tab === 'orders' ? (
          <>
            <OrdersTable
              orders={open}
              positions={positions}
              canTrade={!!canTrade && !!onCancelOrder}
              cancellingOid={cancellingOid ?? null}
              confirmOid={confirmOid}
              onAskCancel={setConfirmOid}
              onConfirmCancel={(o) => {
                setConfirmOid(null);
                onCancelOrder?.(o);
              }}
              onEditOrder={onEditOrder}
            />
            {cancelError ? <p className="px-3 pb-2 text-[11px] text-market-down">{cancelError}</p> : null}
          </>
        ) : tab === 'history' ? (
          histQ.isLoading ? (
            <p className="px-3 py-4 text-[12px] text-fg-subtle">Loading order history…</p>
          ) : (
            <HistoryTable rows={history} />
          )
        ) : tab === 'trades' ? (
          fillsQ.isLoading ? (
            <p className="px-3 py-4 text-[12px] text-fg-subtle">Loading trade history…</p>
          ) : (
            <FillsTable rows={fills} />
          )
        ) : tab === 'builder' && builderAddress ? (
          <>
            <BuilderClaimBar
              builder={builderAddress}
              canClaim={
                !!tenantBuilderAddress &&
                tenantBuilderAddress.toLowerCase() === builderAddress.toLowerCase()
              }
              onClaimed={() => {
                void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', builderAddress] });
              }}
            />
            <PortfolioTable
              clearing={builderClearing}
              canTrade={authenticated && !!builderAddress}
              getEthereumProvider={() => getBuilderEthereumProvider(builderAddress)}
              userAddress={(builderAddress as Hex) ?? null}
              spotDusting={spotDusting}
              forceClassSplit
              showWithdraw
              switchChain={(chainId) => switchBuilderChain(chainId, builderAddress)}
              onDone={() => {
                void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', builderAddress] });
              }}
            />
          </>
        ) : (
          <PortfolioTable
            clearing={clearing}
            canTrade={authenticated && !!authAddress}
            getEthereumProvider={getEthereumProvider}
            userAddress={(authAddress as Hex) ?? null}
            spotDusting={spotDusting}
            sendToFriend
            appName={appName}
            onDone={() => {
              if (!authAddress) return;
              void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', authAddress] });
            }}
          />
        )}
      </div>
    </div>
  );
}

function sameCoin(a: string | null | undefined, b: string) {
  return !!a && a.toUpperCase() === b.toUpperCase();
}

/** Mobile portfolio chevron: ticker + arrow routes to that market. */
function MarketNavSymbol({
  coin,
  selectedCoin,
  resolveMarketCoin,
  onSelect,
}: {
  coin: string;
  selectedCoin?: string | null;
  resolveMarketCoin?: (coin: string) => string | null;
  onSelect?: (coin: string) => void;
}) {
  const label = displaySymbol(coin);
  const target = resolveMarketCoin?.(coin) ?? null;
  const canNav =
    !!onSelect &&
    !!target &&
    !sameCoin(selectedCoin, target) &&
    !sameCoin(selectedCoin, coin);
  if (!canNav || !target) {
    return <span className="font-semibold text-fg">{label}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(target)}
      className="group inline-flex max-w-full items-center gap-0.5 rounded border border-stroke-weak bg-fill-weak/50 py-0.5 pl-1.5 pr-0.5 font-semibold text-fg hover:border-brand/40 hover:bg-brand-soft"
      aria-label={`Open ${label}`}
      title={`Open ${label}`}
    >
      <span className="truncate">{label}</span>
      <IconChevron size={10} className="-rotate-90 text-fg-subtle group-hover:text-brand" />
    </button>
  );
}

function PositionsTable({
  positions,
  markByCoin,
  openedAtByCoin,
  selectedCoin,
  resolveMarketCoin,
  onSelectMarket,
  canTrade,
  closingCoin,
  confirmCoin,
  confirmClose,
  onAskClose,
  onConfirmClose,
  onOpenTpsl,
  onSharePnl,
}: {
  positions: Position[];
  markByCoin: Map<string, number>;
  openedAtByCoin: Map<string, number>;
  selectedCoin?: string | null;
  resolveMarketCoin?: (coin: string) => string | null;
  onSelectMarket?: (coin: string) => void;
  canTrade: boolean;
  closingCoin: string | null;
  confirmCoin: string | null;
  confirmClose: boolean;
  onAskClose: (coin: string | null) => void;
  onConfirmClose: (position: Position) => void;
  onOpenTpsl?: (position: Position, markPx: number) => void;
  onSharePnl?: (payload: {
    coin: string;
    direction: 'LONG' | 'SHORT';
    pnlPercent: number;
    entryPrice: number;
    markPrice: number;
    leverage?: number | null;
  }) => void;
}) {
  if (!positions.length) {
    return <p className="px-4 py-5 text-[12px] text-fg-subtle">No open positions yet</p>;
  }
  return (
    <div className="pr-5">
      <table className="w-full min-w-[1100px] table-fixed text-left text-[11px]">
        <thead className="sticky top-0 bg-background text-fg-subtle">
          <tr>
            <Th className="w-[8%]">Time</Th>
            <Th className="w-[14%]">Market</Th>
            <Th className="w-[7%] text-right">Size</Th>
            <Th className="w-[9%] text-right">Position Value</Th>
            <Th className="w-[8%] text-right">Entry Price</Th>
            <Th className="w-[8%] text-right">Mark Price</Th>
            <Th className="w-[13%] text-right">PNL (ROE %)</Th>
            <Th className="w-[8%] text-right">Liq. Price</Th>
            <Th className="w-[7%] text-right">Margin</Th>
            <Th className="w-[7%] text-right">Funding</Th>
            {canTrade ? <Th className="w-[11%] text-right">Close</Th> : null}
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const long = p.szi > 0;
            const absSz = Math.abs(p.szi);
            const mark = markByCoin.get(p.coin) ?? null;
            const posValue =
              mark != null ? absSz * mark : p.positionValue != null ? Math.abs(p.positionValue) : null;
            const livePnl =
              mark != null && p.entryPx != null ? (mark - p.entryPx) * p.szi : p.unrealizedPnl;
            const roePct =
              livePnl != null && p.marginUsed != null && p.marginUsed > 0
                ? (livePnl / p.marginUsed) * 100
                : p.returnOnEquity != null
                  ? p.returnOnEquity * 100
                  : null;
            const busy = closingCoin === p.coin;
            const confirm = confirmClose && confirmCoin === p.coin;
            const openedAt = openedAtByCoin.get(p.coin) ?? null;
            return (
              <tr
                key={p.coin}
                aria-busy={busy || undefined}
                className={`border-t border-stroke-weak transition-opacity ${
                  busy ? 'pointer-events-none opacity-40' : ''
                }`}
              >
                <Td className="tabular text-fg-subtle">{clock(openedAt ?? 0)}</Td>
                <Td>
                  <span className="inline-flex max-w-full items-center gap-1.5">
                    <MarketNavSymbol
                      coin={p.coin}
                      selectedCoin={selectedCoin}
                      resolveMarketCoin={resolveMarketCoin}
                      onSelect={onSelectMarket}
                    />
                    <span className={`shrink-0 ${long ? 'text-market-up' : 'text-market-down'}`}>
                      {long ? 'Long' : 'Short'}
                      {p.leverage != null ? ` ${Math.round(p.leverage)}x` : ''}
                    </span>
                  </span>
                </Td>
                <Td className={`text-right tabular ${long ? 'text-market-up' : 'text-market-down'}`}>
                  {long ? '' : '−'}
                  {formatSz(absSz)}
                </Td>
                <Td className="text-right tabular">{formatUsd(posValue)}</Td>
                <Td className="text-right tabular">{formatPx(p.entryPx)}</Td>
                <Td className="text-right tabular font-semibold text-fg">{formatPx(mark)}</Td>
                <Td className={`text-right tabular font-semibold ${pnlClass(livePnl)}`}>
                  <span className="relative inline-block">
                    {formatUsd(livePnl)}
                    {roePct != null && Number.isFinite(roePct) ? (
                      <span className="font-medium text-fg-subtle"> ({formatRoe(roePct)})</span>
                    ) : null}
                    {onSharePnl &&
                    p.entryPx != null &&
                    mark != null &&
                    mark > 0 &&
                    roePct != null &&
                    Number.isFinite(roePct) ? (
                      <button
                        type="button"
                        title="Share PnL"
                        aria-label="Share PnL"
                        className="absolute left-full top-1/2 ml-0.5 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-subtle hover:bg-fill-weak hover:text-brand"
                        onClick={() =>
                          onSharePnl({
                            coin: p.coin,
                            direction: long ? 'LONG' : 'SHORT',
                            pnlPercent: roePct,
                            entryPrice: p.entryPx!,
                            markPrice: mark,
                            leverage: p.leverage,
                          })
                        }
                      >
                        <IconExternal size={11} />
                      </button>
                    ) : null}
                  </span>
                </Td>
                <Td className="text-right tabular">{formatPx(p.liquidationPx)}</Td>
                <Td className="text-right tabular">{formatUsd(p.marginUsed)}</Td>
                <Td className={`text-right tabular ${pnlClass(-(p.cumFundingSinceOpen ?? 0))}`}>
                  {p.cumFundingSinceOpen != null ? formatUsd(-p.cumFundingSinceOpen) : '—'}
                </Td>
                {canTrade ? (
                  <Td className="pr-2 text-right">
                    {confirm ? (
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onConfirmClose(p)}
                          className="text-market-down hover:underline disabled:opacity-40"
                        >
                          {busy ? 'Closing…' : 'Confirm'}
                        </button>
                        <button type="button" className="text-fg-subtle hover:underline" onClick={() => onAskClose(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {onOpenTpsl ? (
                          <>
                            <button
                              type="button"
                              disabled={busy || mark == null || mark <= 0 || p.entryPx == null}
                              onClick={() => mark != null && onOpenTpsl(p, mark)}
                              className="text-market-up hover:underline disabled:opacity-40"
                            >
                              TP/SL
                            </button>
                            <span className="text-fg-subtle/50" aria-hidden>
                              |
                            </span>
                          </>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onAskClose(p.coin)}
                          className="text-brand hover:underline disabled:opacity-40"
                        >
                          Close
                        </button>
                      </span>
                    )}
                  </Td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrdersTable({
  orders,
  positions,
  canTrade,
  cancellingOid,
  confirmOid,
  onAskCancel,
  onConfirmCancel,
  onEditOrder,
}: {
  orders: OpenOrder[];
  positions: Position[];
  canTrade: boolean;
  cancellingOid: number | null;
  confirmOid: number | null;
  onAskCancel: (oid: number | null) => void;
  onConfirmCancel: (order: OpenOrder) => void;
  onEditOrder?: (order: OpenOrder) => void;
}) {
  if (!orders.length) {
    return <p className="px-4 py-5 text-[12px] text-fg-subtle">No open orders yet</p>;
  }
  const posSz = new Map(positions.map((p) => [p.coin.toUpperCase(), Math.abs(p.szi)]));
  return (
    <div className="pr-5">
      <table className="w-full min-w-[1080px] table-fixed text-left text-[11px]">
        <thead className="sticky top-0 bg-background text-fg-subtle">
          <tr>
            <Th className="w-[12%]">Time</Th>
            <Th className="w-[10%]">Type</Th>
            <Th className="w-[12%]">Market</Th>
            <Th className="w-[8%]">Direction</Th>
            <Th className="w-[8%] text-right">Size</Th>
            <Th className="w-[9%] text-right">Original Size</Th>
            <Th className="w-[10%] text-right">Order Value</Th>
            <Th className="w-[9%] text-right">Price</Th>
            <Th className="w-[9%] text-right">Trigger</Th>
            <Th className="w-[7%] text-center">Reduce Only</Th>
            {canTrade ? <Th className="w-[10%] text-right"> </Th> : null}
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const buy = o.side === 'B';
            const px = o.isTrigger && o.triggerPx != null ? o.triggerPx : o.limitPx;
            // positionTpsl uses s='0' so HL reports sz=0 — show live position size.
            const isPosTpsl =
              o.isPositionTpsl || ((o.tpsl === 'tp' || o.tpsl === 'sl') && !(o.sz > 0));
            const displaySz = isPosTpsl
              ? (posSz.get(o.coin.toUpperCase()) ?? 0)
              : o.sz;
            const orderValue = displaySz > 0 && px > 0 ? displaySz * px : null;
            const typeLabel = isPosTpsl
              ? o.tpsl === 'tp'
                ? 'Take Profit'
                : o.tpsl === 'sl'
                  ? 'Stop Loss'
                  : o.orderType || 'Trigger'
              : o.orderType && o.orderType !== 'Trigger'
                ? o.orderType
                : o.tpsl === 'tp'
                  ? 'Take Profit'
                  : o.tpsl === 'sl'
                    ? 'Stop Loss'
                    : o.orderType || 'Limit';
            const busy = cancellingOid === o.oid;
            const confirm = confirmOid === o.oid;
            return (
              <tr
                key={o.oid}
                aria-busy={busy || undefined}
                className={`border-t border-stroke-weak transition-opacity ${
                  busy ? 'pointer-events-none opacity-40' : ''
                }`}
              >
                <Td className="tabular text-fg-subtle">{clock(o.timestamp)}</Td>
                <Td>{typeLabel}</Td>
                <Td className="font-semibold">{displaySymbol(o.coin)}</Td>
                <Td className={buy ? 'text-market-up' : 'text-market-down'}>{buy ? 'Long' : 'Short'}</Td>
                <Td className="text-right tabular">
                  {displaySz > 0 ? formatSz(displaySz) : isPosTpsl ? 'Position' : formatSz(o.sz)}
                </Td>
                <Td className="text-right tabular">
                  {isPosTpsl
                    ? displaySz > 0
                      ? formatSz(displaySz)
                      : 'Position'
                    : formatSz(o.origSz)}
                </Td>
                <Td className="text-right tabular">{orderValue != null ? formatUsd(orderValue) : '—'}</Td>
                <Td className="text-right tabular">{formatPx(o.limitPx)}</Td>
                <Td className="text-right tabular text-fg-muted">
                  {o.triggerPx != null ? formatPx(o.triggerPx) : '—'}
                </Td>
                <Td className="text-center text-fg-muted">{o.reduceOnly || isPosTpsl ? 'Yes' : 'No'}</Td>
                {canTrade ? (
                  <Td className="pr-2 text-right">
                    {confirm ? (
                      <span className="inline-flex gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onConfirmCancel(o)}
                          className="text-market-down hover:underline disabled:opacity-40"
                        >
                          {busy ? 'Cancelling…' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          className="text-fg-subtle hover:underline"
                          onClick={() => onAskCancel(null)}
                        >
                          Back
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {onEditOrder ? (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              title={
                                isEditableOpenOrder(o)
                                  ? 'Edit order'
                                  : 'Only limit orders can be edited for now'
                              }
                              onClick={() => onEditOrder(o)}
                              className="text-market-up hover:underline disabled:opacity-40"
                            >
                              Edit
                            </button>
                            <span className="text-fg-subtle/50" aria-hidden>
                              |
                            </span>
                          </>
                        ) : null}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onAskCancel(o.oid)}
                          className="text-brand hover:underline disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </Td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Shared shell so Order History + Trade History line up column-for-column. */
const HISTORY_MIN_W = 'min-w-[720px]';

function HistoryTable({ rows }: { rows: HistoricalOrder[] }) {
  if (!rows.length) {
    return <p className="px-4 py-5 text-[12px] text-fg-subtle">No order history in this app’s catalog.</p>;
  }
  return (
    <div className="pr-5">
      <table className={`w-full ${HISTORY_MIN_W} table-fixed text-left text-[11px]`}>
        <thead className="sticky top-0 bg-background text-fg-subtle">
          <tr>
            <Th className="w-[18%]">Time</Th>
            <Th className="w-[18%]">Market</Th>
            <Th className="w-[12%]">Side</Th>
            <Th className="w-[16%] text-right">Price</Th>
            <Th className="w-[16%] text-right">Size</Th>
            <Th className="w-[20%] text-right">Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={`${o.oid}-${o.timestamp}`} className="border-t border-stroke-weak">
              <Td className="tabular text-fg-subtle">{clock(o.timestamp)}</Td>
              <Td className="font-semibold">{displaySymbol(o.coin)}</Td>
              <Td className={o.side === 'B' ? 'text-market-up' : 'text-market-down'}>
                {o.side === 'B' ? 'Buy' : 'Sell'}
              </Td>
              <Td className="text-right tabular">{formatPx(o.limitPx)}</Td>
              <Td className="text-right tabular">{formatSz(o.sz)}</Td>
              <Td className="text-right capitalize text-fg-muted">{o.status || '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FillsTable({ rows }: { rows: UserFill[] }) {
  if (!rows.length) {
    return <p className="px-4 py-5 text-[12px] text-fg-subtle">No fills in this app’s catalog.</p>;
  }
  return (
    <div className="pr-5">
      <table className={`w-full ${HISTORY_MIN_W} table-fixed text-left text-[11px]`}>
        <thead className="sticky top-0 bg-background text-fg-subtle">
          <tr>
            <Th className="w-[18%]">Time</Th>
            <Th className="w-[18%]">Market</Th>
            <Th className="w-[12%]">Side</Th>
            <Th className="w-[16%] text-right">Price</Th>
            <Th className="w-[16%] text-right">Size</Th>
            <Th className="w-[20%] text-right">Fee</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={`${f.oid ?? i}-${f.time}-${f.px}`} className="border-t border-stroke-weak">
              <Td className="tabular text-fg-subtle">{clock(f.time)}</Td>
              <Td className="font-semibold">{displaySymbol(f.coin)}</Td>
              <Td className={f.side === 'B' ? 'text-market-up' : 'text-market-down'}>
                {f.side === 'B' ? 'Buy' : 'Sell'}
              </Td>
              <Td className="text-right tabular">{formatPx(f.px)}</Td>
              <Td className="text-right tabular">{formatSz(f.sz)}</Td>
              <Td className="text-right tabular text-fg-muted">{formatUsd(f.fee)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortfolioTable({
  clearing,
  canTrade,
  getEthereumProvider,
  userAddress,
  spotDusting,
  onDone,
  forceClassSplit = false,
  showWithdraw = false,
  switchChain,
  sendToFriend = false,
  appName = null,
}: {
  clearing: Clearinghouse | null;
  canTrade: boolean;
  getEthereumProvider: () => Promise<import('../../lib/hlTrade').Eip1193Provider | null>;
  userAddress: Hex | null;
  spotDusting: boolean;
  onDone: () => void;
  /** Builder wallets stay Standard — don't wait on unified setup. */
  forceClassSplit?: boolean;
  showWithdraw?: boolean;
  switchChain?: (chainId: number) => Promise<void>;
  /** Portfolio: HL→HL to another user, not an Arbitrum withdraw. */
  sendToFriend?: boolean;
  appName?: string | null;
}) {
  const setupQ = useHlSetupStatus(forceClassSplit ? null : userAddress);
  const midsQ = useQuery({
    queryKey: ['hl', 'allMids', 'portfolio'],
    queryFn: () => fetchAllMids(),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
  const mids = midsQ.data ?? {};
  const pooled =
    !forceClassSplit &&
    (clearing?.abstractionMode === 'unifiedAccount' ||
      clearing?.abstractionMode === 'portfolioMargin' ||
      !!setupQ.data?.accountMode);
  // Don't flash Perps vs Spot for unified embedded wallets while mode is loading.
  const modeKnown = forceClassSplit || clearing?.abstractionMode != null || setupQ.data != null;
  const showClassSplit = forceClassSplit || (modeKnown && !pooled);
  // HL spot send works on Standard accounts. Unified / PM users (most traders)
  // can't use it — hide the column. Builder wallet stays Standard via forceClassSplit.
  const showSend = showClassSplit;

  const perpTotal = clearing?.perpAccountValue ?? clearing?.accountValue ?? 0;
  const perpAvail = clearing?.perpWithdrawable ?? clearing?.withdrawable ?? 0;
  const spotUsdc = (clearing?.spotBalances ?? []).find((b) => b.coin.toUpperCase() === 'USDC');
  const spotUsdcTotal = spotUsdc?.total ?? clearing?.spotUsdc ?? 0;
  const spotUsdcAvail = spotUsdc ? Math.max(0, spotUsdc.total - spotUsdc.hold) : spotUsdcTotal;
  const unifiedTotal = clearing?.accountValue ?? spotUsdcTotal;
  const unifiedAvail = clearing?.withdrawable ?? spotUsdcAvail;

  const allOthers = (clearing?.spotBalances ?? []).filter((b) => b.coin.toUpperCase() !== 'USDC');

  const [sheet, setSheet] = useState<null | {
    kind: 'send' | 'transfer' | 'withdraw';
    coin: string;
    toPerp?: boolean;
    available: number;
  }>(null);
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amountTouched, setAmountTouched] = useState(false);
  const [destTouched, setDestTouched] = useState(false);

  const resetSheet = () => {
    setErr(null);
    setAmount('');
    setDest('');
    setAmountTouched(false);
    setDestTouched(false);
  };
  const openTransfer = (toPerp: boolean, available: number) => {
    resetSheet();
    setSheet({ kind: 'transfer', coin: 'USDC', toPerp, available });
  };
  const openSend = (coin: string, available: number) => {
    resetSheet();
    setSheet({ kind: 'send', coin, available });
  };
  const openWithdraw = (available: number) => {
    resetSheet();
    setSheet({ kind: 'withdraw', coin: 'USDC', available });
  };

  const amt = Number(amount.trim());
  const amountBlank = !amount.trim();
  const amountParsed = !amountBlank && Number.isFinite(amt);
  const minUsd = sheet?.kind === 'withdraw' ? MIN_HL_WITHDRAW_USDC : null;
  const amountTooLow = minUsd != null && amountParsed && amt > 0 && amt < minUsd;
  const amountTooHigh = amountParsed && sheet != null && amt - sheet.available > 1e-8;
  const amountInvalid =
    amountTouched && !amountBlank && (!amountParsed || amt <= 0 || amountTooLow || amountTooHigh);
  const amountError =
    !amountTouched || amountBlank
      ? null
      : !amountParsed || amt <= 0
        ? 'Enter a valid amount'
        : amountTooLow
          ? `Minimum is $${minUsd}`
          : amountTooHigh
            ? 'Amount is larger than available'
            : null;

  const destNeeded = sheet?.kind === 'send' || sheet?.kind === 'withdraw';
  const destTrim = dest.trim();
  const destValid = /^0x[a-f0-9]{40}$/.test(destTrim.toLowerCase());
  const destInvalid = !!destNeeded && !destValid && (destTouched || destTrim.length >= 42);
  const destError = destInvalid
    ? sendToFriend
      ? "Enter your friend's address"
      : 'Enter a valid destination address'
    : null;

  const canSubmit =
    !busy &&
    amountParsed &&
    amt > 0 &&
    !amountTooLow &&
    !amountTooHigh &&
    (!destNeeded || destValid);

  const submit = async () => {
    if (!sheet || !userAddress) return;
    setAmountTouched(true);
    if (destNeeded) setDestTouched(true);
    if (!canSubmit) return;
    const n = amt;
    setBusy(true);
    setErr(null);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const amt = n.toFixed(8).replace(/\.?0+$/, '');
      if (sheet.kind === 'transfer') {
        await transferUsdSpotPerp({
          provider,
          userAddress,
          amountUsd: amt,
          toPerp: !!sheet.toPerp,
        });
      } else if (sheet.kind === 'withdraw') {
        await switchChain?.(ARBITRUM_CHAIN_ID);
        await withdrawFromHyperliquid({
          provider,
          userAddress,
          destination: dest.trim().toLowerCase() as Hex,
          amountUsd: n.toFixed(2),
        });
      } else {
        const destHex = dest.trim().toLowerCase() as Hex;
        if (sheet.coin === 'USDC') {
          await sendPerpUsdc({ provider, userAddress, destination: destHex, amountUsd: amt });
        } else {
          await sendSpotToken({
            provider,
            userAddress,
            destination: destHex,
            coin: sheet.coin === 'USDC-SPOT' ? 'USDC' : sheet.coin,
            amount: amt,
          });
        }
      }
      setSheet(null);
      onDone();
    } catch (e) {
      setErr(
        isWalletUserRejectedRequest(e)
          ? 'Wallet request was rejected.'
          : e instanceof Error
            ? e.message
            : 'Request failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const tokenUsd = (b: SpotBalance): number | null => {
    if (b.coin.toUpperCase() === 'USDC') return b.total;
    const px =
      midFor(mids, `${b.coin}/USDC`) ??
      midFor(mids, b.coin) ??
      midFor(mids, `U${b.coin}`) ??
      null;
    if (px == null || px <= 0) return null;
    return b.total * px;
  };

  const visibleOthers = allOthers.filter((b) => {
    if (!spotDusting) return true;
    const usd = tokenUsd(b);
    if (usd == null) return true;
    return usd >= SPOT_DUST_USD;
  });
  const hiddenDust = allOthers.length - visibleOthers.length;

  const sendBtn = (coin: string, available: number) =>
    canTrade ? (
      <button
        type="button"
        className="font-bold text-market-up hover:underline"
        onClick={() => openSend(coin, available)}
      >
        {sendToFriend ? 'Send to a friend' : 'Send'}
      </button>
    ) : (
      '—'
    );

  const withdrawBtn = (available: number) =>
    canTrade ? (
      <button
        type="button"
        className="font-bold text-market-up hover:underline"
        onClick={() => openWithdraw(available)}
      >
        Withdraw
      </button>
    ) : (
      '—'
    );

  return (
    <div className="relative">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-background text-fg-subtle">
          <tr>
            <Th className="pl-4 pr-8">Asset</Th>
            <Th className="px-8 text-right">Total Balance</Th>
            <Th className="px-8 text-right">Available Balance</Th>
            <Th className="px-8 text-right">USDC Value</Th>
            {showSend ? (
              <Th className="px-8 whitespace-nowrap">{sendToFriend ? 'Send to a friend' : 'Send'}</Th>
            ) : null}
            {showClassSplit ? <Th className="px-8 whitespace-nowrap">Transfer</Th> : null}
            {showWithdraw ? <Th className="pl-8 pr-4 whitespace-nowrap">Withdraw</Th> : null}
          </tr>
        </thead>
        <tbody>
          {showClassSplit ? (
            <>
              <tr className="border-t border-stroke-weak">
                <Td className="pl-4 pr-8 font-semibold">USDC (Perps)</Td>
                <Td className="px-8 text-right tabular">{formatSz(perpTotal)} USDC</Td>
                <Td className="px-8 text-right tabular">{formatSz(perpAvail)} USDC</Td>
                <Td className="px-8 text-right tabular">{formatUsd(perpTotal)}</Td>
                {showSend ? <Td className="px-8">{sendBtn('USDC', perpAvail)}</Td> : null}
                <Td className={showWithdraw ? 'px-8' : 'pl-8 pr-4'}>
                  {canTrade ? (
                    <button
                      type="button"
                      className="font-bold text-market-up hover:underline"
                      onClick={() => openTransfer(false, perpAvail)}
                    >
                      Transfer to Spot
                    </button>
                  ) : (
                    '—'
                  )}
                </Td>
                {showWithdraw ? <Td className="pl-8 pr-4">{withdrawBtn(perpAvail)}</Td> : null}
              </tr>
              <tr className="border-t border-stroke-weak">
                <Td className="pl-4 pr-8 font-semibold">USDC (Spot)</Td>
                <Td className="px-8 text-right tabular">{formatSz(spotUsdcTotal)} USDC</Td>
                <Td className="px-8 text-right tabular">{formatSz(spotUsdcAvail)} USDC</Td>
                <Td className="px-8 text-right tabular">{formatUsd(spotUsdcTotal)}</Td>
                {showSend ? <Td className="px-8">{sendBtn('USDC-SPOT', spotUsdcAvail)}</Td> : null}
                <Td className={showWithdraw ? 'px-8' : 'pl-8 pr-4'}>
                  {canTrade ? (
                    <button
                      type="button"
                      className="font-bold text-market-up hover:underline"
                      onClick={() => openTransfer(true, spotUsdcAvail)}
                    >
                      Transfer to Perps
                    </button>
                  ) : (
                    '—'
                  )}
                </Td>
                {showWithdraw ? <Td className="pl-8 pr-4 text-fg-subtle">—</Td> : null}
              </tr>
            </>
          ) : (
            <tr className="border-t border-stroke-weak">
              <Td className="pl-4 pr-8 font-semibold">USDC</Td>
              <Td className="px-8 text-right tabular">{formatSz(unifiedTotal)} USDC</Td>
              <Td className="px-8 text-right tabular">{formatSz(unifiedAvail)} USDC</Td>
              <Td className="px-8 text-right tabular">{formatUsd(unifiedTotal)}</Td>
              {showSend ? <Td className="px-8">{sendBtn('USDC', unifiedAvail)}</Td> : null}
              {showWithdraw ? <Td className="pl-8 pr-4">{withdrawBtn(unifiedAvail)}</Td> : null}
            </tr>
          )}
          {visibleOthers.map((b) => {
            const usd = tokenUsd(b);
            const avail = Math.max(0, b.total - b.hold);
            return (
              <tr key={b.coin} className="border-t border-stroke-weak">
                <Td className="pl-4 pr-8 font-semibold">{b.coin}</Td>
                <Td className="px-8 text-right tabular">
                  {formatSz(b.total)} {b.coin}
                </Td>
                <Td className="px-8 text-right tabular">
                  {formatSz(avail)} {b.coin}
                </Td>
                <Td className="px-8 text-right tabular">{usd != null ? formatUsd(usd) : '—'}</Td>
                {showSend ? <Td className="px-8">{sendBtn(b.coin, avail)}</Td> : null}
                {showClassSplit ? (
                  <Td className={showWithdraw ? 'px-8 text-fg-subtle' : 'pl-8 pr-4 text-fg-subtle'}>—</Td>
                ) : null}
                {showWithdraw ? <Td className="pl-8 pr-4 text-fg-subtle">—</Td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hiddenDust > 0 ? (
        <p className="px-4 py-2 text-[11px] text-fg-subtle">
          Hiding {hiddenDust} spot token{hiddenDust === 1 ? '' : 's'} under ${SPOT_DUST_USD.toFixed(2)} — turn off Spot
          dusting in Trade settings to show them.
        </p>
      ) : null}

      {sheet ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <button type="button" className="absolute inset-0 bg-black/55" aria-label="Close" onClick={() => !busy && setSheet(null)} />
          <div className="relative w-full max-w-sm rounded-2xl border border-stroke-weak bg-background p-4 shadow-xl">
            <div className="text-[15px] font-extrabold">
              {sheet.kind === 'transfer'
                ? sheet.toPerp
                  ? 'Transfer to Perps'
                  : 'Transfer to Spot'
                : sheet.kind === 'withdraw'
                  ? 'Withdraw USDC'
                  : sendToFriend
                    ? 'Send to a friend'
                    : `Send ${sheet.coin === 'USDC-SPOT' ? 'USDC (Spot)' : sheet.coin === 'USDC' ? (showClassSplit ? 'USDC (Perps)' : 'USDC') : sheet.coin}`}
            </div>
            {sheet.kind === 'send' || sheet.kind === 'withdraw' ? (
              <label className="mt-3 block text-[11px] text-fg-subtle">
                {sheet.kind === 'send' && sendToFriend ? 'Friend' : 'Destination'}
                <input
                  className="field mt-1 w-full py-2 text-[12px]"
                  value={dest}
                  onChange={(e) => {
                    setDest(e.target.value);
                    setErr(null);
                  }}
                  onBlur={() => setDestTouched(true)}
                  placeholder="0x…"
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={destInvalid || undefined}
                />
              </label>
            ) : null}
            {destError ? <p className="mt-1.5 text-[11px] text-market-down">{destError}</p> : null}
            <label className="mt-3 block text-[11px] text-fg-subtle">
              Amount
              <div className="relative mt-1">
                <input
                  className="field w-full py-2 pr-12 text-[13px] tabular"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setAmountTouched(true);
                    setErr(null);
                  }}
                  onBlur={() => setAmountTouched(true)}
                  inputMode="decimal"
                  placeholder={minUsd != null ? String(minUsd) : '0.00'}
                  disabled={busy}
                  aria-invalid={amountInvalid || undefined}
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-extrabold text-brand"
                  onClick={() => {
                    setAmount(String(sheet.available));
                    setAmountTouched(true);
                    setErr(null);
                  }}
                  disabled={busy}
                >
                  Max
                </button>
              </div>
            </label>
            <p className="mt-1.5 text-[11px] leading-4 text-fg-subtle">
              Available:{' '}
              <span className="font-bold tabular text-fg">{formatSz(sheet.available)}</span>{' '}
              {sheet.kind === 'send' && sheet.coin !== 'USDC' && sheet.coin !== 'USDC-SPOT'
                ? sheet.coin
                : 'USDC'}
            </p>
            {amountError ? <p className="mt-1 text-[11px] text-market-down">{amountError}</p> : null}
            <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
              {sheet.kind === 'withdraw'
                ? `Fee: ${HL_WITHDRAW_FEE_USDC} USDC — Minimum is $${MIN_HL_WITHDRAW_USDC}`
                : 'Fee: Free'}
            </p>
            {sheet.kind === 'send' ? (
              <p className="mt-1 text-[11px] leading-4 text-fg-muted">
                {sendToFriend
                  ? `Sending to a ${appName?.trim() ? `${appName.trim()} friend` : 'friend'}. This is free except if your friend has a new wallet with no activity — then it costs 1 USDC.`
                  : 'Sending to a brand-new HL address costs 1 USDC to activate it. This is not an Arbitrum withdrawal.'}
              </p>
            ) : sheet.kind === 'withdraw' ? (
              <p className="mt-1 text-[11px] leading-4 text-fg-muted">Lands on Arbitrum.</p>
            ) : null}
            {err && err !== amountError && err !== destError ? (
              <p className="mt-2 text-[11px] text-market-down">{err}</p>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="rounded-md bg-fill-weak py-2 text-[13px] font-extrabold hover:bg-fill-hover"
                disabled={busy}
                onClick={() => setSheet(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md bg-brand py-2 text-[13px] font-extrabold text-[#06140c] disabled:opacity-45"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {busy ? 'Signing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BuilderClaimBar({
  builder,
  canClaim,
  onClaimed,
}: {
  builder: string;
  canClaim: boolean;
  onClaimed: () => void;
}) {
  const { getBuilderEthereumProvider } = useWebAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rewards = useQuery({
    queryKey: ['hl-referral', builder.toLowerCase()],
    enabled: canClaim && !!builder,
    queryFn: () => fetchHlRewards(builder as Hex),
    refetchInterval: 30_000,
  });

  const unclaimed = rewards.data?.unclaimed ?? 0;
  const ready = unclaimed >= HL_CLAIM_MIN_USD;

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(builder);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const claim = async () => {
    setError(null);
    setBusy(true);
    try {
      const provider = await getBuilderEthereumProvider(builder);
      if (!provider) throw new Error('Builder wallet is not ready');
      await claimHlRewards({ builder: builder as Hex, provider });
      void qc.invalidateQueries({ queryKey: ['hl-referral'] });
      void qc.invalidateQueries({ queryKey: ['my-tenants'] });
      onClaimed();
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected.');
      else setError(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  if (!canClaim) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-weak px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[12px] text-fg-subtle">
          Claimable{' '}
          <span className="font-bold tabular text-fg">
            {rewards.isLoading ? '—' : formatEarnedUsd(unclaimed)}
          </span>
          {!ready && unclaimed > 0 ? (
            <span className="text-fg-muted"> · needs ${HL_CLAIM_MIN_USD}+</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => void copyAddress()}
          title={builder}
          aria-label={copied ? 'Copied builder address' : 'Copy builder address'}
          className="group inline-flex h-6 items-center gap-1.5 rounded-full border border-stroke-weak bg-fill-weaker pl-2.5 pr-1.5 text-[11px] font-bold tabular text-fg-muted transition-colors hover:border-stroke-strong hover:text-fg"
        >
          <span>{shortAddr(builder)}</span>
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${
              copied ? 'bg-success/15 text-success' : 'text-fg-subtle group-hover:text-fg'
            }`}
          >
            {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
          </span>
        </button>
      </div>
      <button
        type="button"
        className="rounded-md bg-brand px-3 py-1 text-[11px] font-extrabold text-[#06140c] disabled:opacity-45"
        disabled={busy || rewards.isLoading || !ready}
        onClick={() => void claim()}
      >
        {busy ? 'Claiming…' : 'Claim'}
      </button>
      {error ? <p className="w-full text-[11px] text-market-down">{error}</p> : null}
    </div>
  );
}

function Th({ children, className = '' }: { children: string; className?: string }) {
  return <th className={`whitespace-nowrap px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>;
}

function pnlClass(v: number | null): string {
  if (v == null || v === 0) return 'text-fg-muted';
  return v > 0 ? 'text-market-up' : 'text-market-down';
}

function formatRoe(pct: number): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function clock(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
