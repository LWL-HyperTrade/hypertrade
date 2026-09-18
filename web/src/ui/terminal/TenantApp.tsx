import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loginHref, useWebAuth } from '../../lib/auth';
import { fetchCatalogAssets, fetchTenant, patchTenant, recordTenantOrder } from '../../lib/api';
import {
  cancelDeskOrder,
  cancelDeskOrders,
  ensureTradingReady,
  getAssetIdAndMeta,
  getSpotAssetData,
  invalidateTradingReady,
  isWalletUserRejectedRequest,
  marketCloseDeskPosition,
  modifyDeskOrder,
  placePositionTpsl,
  type Hex,
} from '../../lib/hlTrade';
import { canToggleSpot, spotLookupName } from '../../lib/spotMarkets';
import { filterAssetsForTenant, normalizeWebsiteUrl, pickDefaultMarket, type TenantPublic } from '../../lib/tenants';
import { resolveListedMarket } from './catalogMatch';
import {
  type CandleInterval,
  type Clearinghouse,
  type OpenOrder,
  change24h,
  dexFromCoin,
  displaySymbol,
  formatFunding,
  formatFundingCountdown,
  formatMarkStable,
  formatPct,
  formatPx,
  formatUsd,
  HIP3_DEXES,
  isEditableOpenOrder,
  msUntilNextFunding,
  num,
} from '../../lib/hlMarket';
import { buildChartLines } from '../../lib/chartLines';
import { getConfirmCloseOrders, getOrderNotifications, getSpotDusting } from '../../lib/tradePrefs';
import { getSavedChartInterval, saveChartInterval } from '../../lib/chartPrefs';
import { useHlMarket } from '../../lib/useHlMarket';
import { useHlAllMidsSocket } from '../../lib/useHlAllMids';
import { useHlAccount } from '../../lib/useHlAccount';
import { useRollingNumber } from '../Rolling';
import { CandleChart } from './CandleChart';
import { OrderBook } from './OrderBook';
import { OrderTicket } from './OrderTicket';
import { AccountDock } from './AccountDock';
import { SymbolPicker } from './SymbolPicker';
import { FeesSheet } from '../FeesSheet';
import { WalletSheet } from '../WalletSheet';
import { useTenantPaths } from '../../lib/brandedHost';
import { useCreatorFavicon } from '../../lib/useTenantBrand';
import { MARKET_NAV } from '../../lib/marketNav';
import type { SymbolPickerTab } from '../../lib/marketNav';
import {
  IconChevron,
  IconClose,
  IconDiscord,
  IconGear,
  IconGlobe,
  IconInstagram,
  IconMenu,
  IconTelegram,
  IconTikTok,
  IconTwitch,
  IconX,
  IconYouTube,
} from '../icons';
import { TradeDeskSkeleton } from '../skeleton';
import { quoteLogoSrc } from '../../lib/quoteLogos';
import { ScrollFadeX } from '../ScrollFadeX';
import { TradeToast, type TradeToastPayload } from './TradeToast';
import { StreamDock, StreamDockRestoreButton } from './StreamDock';
import { TradeSettingsSheet } from './TradeSettingsSheet';
import { PositionTpslSheet, type PositionTpslTarget } from './PositionTpslSheet';
import { EditOrderSheet, type EditOrderTarget } from './EditOrderSheet';
import { PnlShareModal, type PnlSharePayload } from './PnlShareModal';

type Props = {
  slug: string;
  coin?: string;
};

export function TenantApp({ slug, coin }: Props) {
  const { authenticated, getAccessToken, getEthereumProvider, address, builderAddress, hydrating } = useWebAuth();
  const paths = useTenantPaths();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accountRef = useRef<HTMLDivElement>(null);
  const streamSlotRef = useRef<HTMLSpanElement>(null);
  const [interval, setInterval] = useState<CandleInterval>(() => getSavedChartInterval());
  const [busy, setBusy] = useState(false);
  const [closingCoin, setClosingCoin] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [cancellingOid, setCancellingOid] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<SymbolPickerTab>('all');
  const [feesOpen, setFeesOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [fundingLeftMs, setFundingLeftMs] = useState(() => msUntilNextFunding());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<TradeToastPayload | null>(null);
  const [tpslTarget, setTpslTarget] = useState<PositionTpslTarget | null>(null);
  const [tpslBusy, setTpslBusy] = useState(false);
  const [tpslError, setTpslError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditOrderTarget | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pnlShare, setPnlShare] = useState<PnlSharePayload | null>(null);
  const [prefsTick, setPrefsTick] = useState(0);
  const [chartOpen, setChartOpen] = useState(true);
  const [bookOpen, setBookOpen] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true,
  );

  const tenantQ = useQuery({
    queryKey: ['tenant', slug, authenticated],
    enabled: !!slug,
    queryFn: async () => {
      const token = authenticated ? await getAccessToken() : null;
      return fetchTenant(slug, token);
    },
  });
  const catalogQ = useQuery({
    queryKey: ['catalog'],
    queryFn: fetchCatalogAssets,
    staleTime: 60_000,
  });

  const tenant = tenantQ.data;
  // Creator icon stays in the tab on /trade/* (CreatorShell is not mounted here).
  useCreatorFavicon(tenant);
  const markets = useMemo(
    () => (tenant && catalogQ.data ? filterAssetsForTenant(catalogQ.data, tenant.catalog) : []),
    [tenant, catalogQ.data],
  );
  const midsDexes = useMemo(() => {
    const d = new Set<string>(HIP3_DEXES);
    for (const m of markets) {
      const dex = dexFromCoin(m.coin);
      if (dex) d.add(dex.toLowerCase());
    }
    return [...d];
  }, [markets]);
  useHlAllMidsSocket(midsDexes);

  const selected = useMemo(() => {
    if (!markets.length) return null;
    if (coin) {
      let decoded = coin;
      try {
        decoded = decodeURIComponent(coin);
      } catch {
        /* keep raw — already decoded, or malformed % */
      }
      const hit = resolveListedMarket(markets, decoded);
      if (hit) return hit;
    }
    return pickDefaultMarket(markets);
  }, [markets, coin]);

  const canSpot = selected
    ? canToggleSpot(selected.coin, selected.symbol, selected.isSpotOnly)
    : false;
  const isSpotMode = !!selected && (selected.isSpotOnly || (searchParams.get('market') === 'spot' && canSpot));

  const spotQ = useQuery({
    queryKey: ['hl', 'spot-asset', selected?.coin],
    enabled: isSpotMode && !!selected,
    queryFn: () => getSpotAssetData(spotLookupName(selected!.coin, selected!.symbol)),
    staleTime: 30_000,
    retry: 1,
  });

  const bookCoin = isSpotMode ? (spotQ.data?.spotSymbol ?? '') : (selected?.coin ?? '');
  // Order-book grouping chosen in the book panel → HL `nSigFigs` on the l2Book feed.
  const [bookSigFigs, setBookSigFigs] = useState<number | null>(null);
  const market = useHlMarket(bookCoin, interval, { spot: isSpotMode, bookSigFigs });
  const account = useHlAccount(address);

  // Keep close/cancel rows dimmed until HL account data drops them — clearing
  // busy in `finally` flashed the row back to full opacity before refetch.
  useEffect(() => {
    if (!closingCoin) return;
    const stillOpen = account.clearing?.positions.some(
      (p) => p.coin.toUpperCase() === closingCoin.toUpperCase(),
    );
    if (!stillOpen) setClosingCoin(null);
  }, [account.clearing?.positions, closingCoin]);

  useEffect(() => {
    if (cancellingOid == null) return;
    const stillOpen = account.orders.some((o) => o.oid === cancellingOid);
    if (!stillOpen) setCancellingOid(null);
  }, [account.orders, cancellingOid]);

  useEffect(() => {
    if (!closingCoin) return;
    const id = window.setTimeout(() => {
      setClosingCoin((cur) => (cur === closingCoin ? null : cur));
    }, 15_000);
    return () => window.clearTimeout(id);
  }, [closingCoin]);

  useEffect(() => {
    if (cancellingOid == null) return;
    const id = window.setTimeout(() => {
      setCancellingOid((cur) => (cur === cancellingOid ? null : cur));
    }, 15_000);
    return () => window.clearTimeout(id);
  }, [cancellingOid]);

  const distinctBuilder =
    builderAddress && (!address || builderAddress.toLowerCase() !== address.toLowerCase())
      ? builderAddress
      : null;
  const builderAccount = useHlAccount(
    authenticated && tenantQ.data?.privy_user_id ? distinctBuilder : null,
  );
  const metaQ = useQuery({
    queryKey: ['hl', 'asset-meta', selected?.coin],
    enabled: !!selected?.coin && !isSpotMode,
    queryFn: () => getAssetIdAndMeta(selected!.coin),
    staleTime: 60_000,
  });

  useEffect(() => {
    const tick = () => setFundingLeftMs(msUntilNextFunding());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => {
      if (mq.matches) {
        setChartOpen(true);
        setBookOpen(true);
      }
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const notify = useCallback(
    (payload: TradeToastPayload) => {
      if (!getOrderNotifications(address)) return;
      setToast(payload);
    },
    [address],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const mark = isSpotMode
    ? (market.ctx?.midPx ??
        market.ctx?.markPx ??
        spotQ.data?.midPx ??
        spotQ.data?.markPx ??
        num(selected?.markPx))
    : (market.ctx?.markPx ?? market.ctx?.midPx ?? num(selected?.markPx));
  const chg = change24h(mark, market.ctx?.prevDayPx ?? null) ?? selected?.change24h ?? null;
  const symbol = selected ? displaySymbol(selected.coin, selected.symbol) : '';
  const pairLabel = symbol ? `${symbol}-USDC` : '—';

  // Entry / liq / TP-SL / limit lines for the chart. Spot has no perp
  // position and its order coins are named differently — perps only.
  const chartLines = useMemo(
    () =>
      selected && !isSpotMode
        ? buildChartLines({
            coin: selected.coin,
            positions: account.clearing?.positions,
            orders: account.orders,
            mark,
          })
        : [],
    [selected, isSpotMode, account.clearing?.positions, account.orders, mark],
  );

  useEffect(() => {
    const prev = document.title;
    return () => {
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    const pair = symbol ? `${symbol}USDC` : '';
    if (mark != null && Number.isFinite(mark) && pair) {
      document.title = `${formatPx(mark)} | ${pair}`;
      return;
    }
    if (pair) document.title = pair;
  }, [mark, symbol]);
  const logo = symbol ? quoteLogoSrc(symbol) : null;
  const maxLev = isSpotMode
    ? null
    : Number.isFinite(metaQ.data?.maxLeverage) && (metaQ.data?.maxLeverage as number) > 0
      ? Math.floor(metaQ.data!.maxLeverage as number)
      : null;

  const spotUsdcRow = account.clearing?.spotBalances?.find((b) => b.coin.toUpperCase() === 'USDC');
  const spotUsdcAvailable = spotUsdcRow
    ? Math.max(0, spotUsdcRow.total - spotUsdcRow.hold)
    : (account.clearing?.spotUsdc ?? 0);
  const spotBaseCoin = spotQ.data?.baseCoin ?? null;
  const spotBaseRow = spotBaseCoin
    ? account.clearing?.spotBalances?.find((b) => b.coin.toUpperCase() === spotBaseCoin.toUpperCase())
    : undefined;
  const spotBaseAvailable = spotBaseRow ? Math.max(0, spotBaseRow.total - spotBaseRow.hold) : 0;

  const openPicker = (tab: SymbolPickerTab = 'all') => {
    setPickerTab(tab);
    setPickerOpen(true);
  };

  const pickMarket = (next: string, opts?: { spot?: boolean }) => {
    if (!tenant) return;
    setPickerOpen(false);
    const row = resolveListedMarket(markets, next);
    if (!row) return;
    const asSpot = !!row.isSpotOnly || !!opts?.spot;
    const url = paths.trade(tenant.slug, row.coin);
    navigate(asSpot ? `${url}?market=spot` : url);
  };

  const setMarketType = (next: 'perp' | 'spot') => {
    if (!tenant || !selected) return;
    const url = paths.trade(tenant.slug, selected.coin);
    navigate(next === 'spot' ? `${url}?market=spot` : url, { replace: true });
  };

  if (tenantQ.isLoading || !slug) {
    return <TradeDeskSkeleton />;
  }
  if (tenantQ.isError || !tenant) {
    return (
      <AppFrame>
        <div className="p-6">
          <h1 className="text-lg font-semibold">App not found</h1>
          <p className="mt-1 text-[13px] text-fg-muted">This trading app is not live.</p>
          <Link to="/explore" className="mt-4 inline-block text-[13px] text-brand">
            Back to apps
          </Link>
        </div>
      </AppFrame>
    );
  }

  if (!coin && selected) {
    const url = paths.trade(tenant.slug, selected.coin);
    const asSpot = !!selected.isSpotOnly || searchParams.get('market') === 'spot';
    return <Navigate to={asSpot ? `${url}?market=spot` : url} replace />;
  }

  const isOwner = authenticated && !!tenant.privy_user_id;

  const closePosition = async (position: Clearinghouse['positions'][number]) => {
    if (!address || !tenant || tenant.status !== 'live') return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setCloseError('Trade wallet required — builder wallet cannot close positions.');
      notify({ kind: 'err', message: 'Trade wallet required — builder wallet cannot close positions.' });
      return;
    }
    setCloseError(null);
    setClosingCoin(position.coin);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const userAddress = address as Hex;
      const ready = await ensureTradingReady({
        provider,
        userAddress,
        requiredFeeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });
      const result = await marketCloseDeskPosition({
        agentPrivateKey: ready.agentPrivateKey,
        symbol: position.coin,
        szi: position.szi,
        // Live WS mark as the fallback if the fresh mid read fails — never 0.
        oraclePx: num(markets.find((m) => m.coin === position.coin)?.markPx) ?? undefined,
        feeTenths: tenant.builder_fee_tenths,
        cloidPrefix: tenant.cloid_prefix,
        builderAddress: tenant.builder_address,
      });
      // Attribution is best-effort (same as mobile TenantProvider); do not
      // keep the row spinning on it.
      void (async () => {
        try {
          const token = await getAccessToken();
          if (!token) return;
          await recordTenantOrder(
            tenant.slug,
            {
              cloid: result.cloid,
              oid: result.oid,
              symbol: position.coin,
              wallet_address: userAddress,
              notional_usd: result.notionalUsd,
              side: result.side,
              reduce_only: true,
            },
            token,
          );
        } catch {
          /* best-effort */
        }
      })();
      notify({ kind: 'ok', message: `Closed ${displaySymbol(position.coin)} position` });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'userFills', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'userFills', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'clearinghouse', address] });
    } catch (e) {
      invalidateTradingReady(address as Hex);
      const msg = isWalletUserRejectedRequest(e)
        ? 'Wallet request was rejected.'
        : e instanceof Error
          ? e.message
          : 'Close failed';
      setCloseError(msg);
      notify({ kind: 'err', message: msg });
      setClosingCoin(null);
    }
  };

  const submitPositionTpsl = async (tp: number | null, sl: number | null) => {
    if (!tpslTarget || !address || !tenant || tenant.status !== 'live') return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setTpslError('Trade wallet required — builder wallet cannot set TP/SL.');
      return;
    }
    const entrySide = tpslTarget.entrySide;
    const entryPx = tpslTarget.entryPx;
    if (tp != null) {
      if (entrySide === 'long' && tp <= entryPx) {
        setTpslError('Take profit must be above entry for a long.');
        return;
      }
      if (entrySide === 'short' && tp >= entryPx) {
        setTpslError('Take profit must be below entry for a short.');
        return;
      }
    }
    if (sl != null) {
      if (entrySide === 'long' && sl >= entryPx) {
        setTpslError('Stop loss must be below entry for a long.');
        return;
      }
      if (entrySide === 'short' && sl <= entryPx) {
        setTpslError('Stop loss must be above entry for a short.');
        return;
      }
    }

    setTpslBusy(true);
    setTpslError(null);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const ready = await ensureTradingReady({
        provider,
        userAddress: address as Hex,
        requiredFeeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });

      // Two exchange actions total, whatever the count: one batched cancel of
      // the existing TP/SL triggers, then one `positionTpsl` order carrying
      // both legs. Cancel stays first so the position never has two live
      // pairs; replacing an already-gone order is best-effort.
      const existing = account.orders.filter(
        (o) =>
          o.coin.toUpperCase() === tpslTarget.coin.toUpperCase() &&
          (o.tpsl === 'tp' || o.tpsl === 'sl') &&
          Number.isFinite(o.oid) &&
          o.oid > 0,
      );
      try {
        await cancelDeskOrders({
          agentPrivateKey: ready.agentPrivateKey,
          orders: existing.map((o) => ({ symbol: o.coin, oid: o.oid })),
        });
      } catch {
        /* replace best-effort */
      }

      await placePositionTpsl({
        agentPrivateKey: ready.agentPrivateKey,
        symbol: tpslTarget.coin,
        entrySide,
        tpTriggerPx: tp,
        slTriggerPx: sl,
        feeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });

      setTpslTarget(null);
      notify({ kind: 'ok', message: `TP/SL set on ${displaySymbol(tpslTarget.coin)}` });
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'openOrders', address] });
    } catch (e) {
      invalidateTradingReady(address as Hex);
      const msg = isWalletUserRejectedRequest(e)
        ? 'Wallet request was rejected.'
        : e instanceof Error
          ? e.message
          : 'TP/SL failed';
      setTpslError(msg);
      notify({ kind: 'err', message: msg });
    } finally {
      setTpslBusy(false);
    }
  };

  const cancelOrder = async (order: OpenOrder) => {
    if (!address || !tenant || tenant.status !== 'live') return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setCancelError('Trade wallet required — builder wallet cannot cancel orders.');
      return;
    }
    setCancelError(null);
    setCancellingOid(order.oid);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const userAddress = address as Hex;
      const ready = await ensureTradingReady({
        provider,
        userAddress,
        requiredFeeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });
      await cancelDeskOrder({
        agentPrivateKey: ready.agentPrivateKey,
        symbol: order.coin,
        oid: order.oid,
      });
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'openOrders', address] });
    } catch (e) {
      invalidateTradingReady(address as Hex);
      if (isWalletUserRejectedRequest(e)) {
        setCancelError('Wallet request was rejected.');
      } else {
        setCancelError(e instanceof Error ? e.message : 'Cancel failed');
      }
      setCancellingOid(null);
    }
  };

  const openEditOrder = (order: OpenOrder) => {
    if (!isEditableOpenOrder(order)) {
      notify({ kind: 'err', message: 'Only limit orders can be edited for now' });
      return;
    }
    const pos = account.clearing?.positions.find((p) => p.coin.toUpperCase() === order.coin.toUpperCase());
    const isPosTpsl =
      order.isPositionTpsl || ((order.tpsl === 'tp' || order.tpsl === 'sl') && !(order.sz > 0));
    const displaySz = isPosTpsl ? (pos ? Math.abs(pos.szi) : 0) : order.sz;
    const liveMark =
      selected?.coin === order.coin && mark != null && mark > 0
        ? mark
        : num(markets.find((m) => m.coin === order.coin)?.markPx);
    setEditError(null);
    setEditTarget({
      order,
      displaySz,
      markPx: liveMark != null && liveMark > 0 ? liveMark : null,
    });
  };

  const submitEditOrder = async (px: number, size: number) => {
    if (!editTarget || !address || !tenant || tenant.status !== 'live') return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setEditError('Trade wallet required — builder wallet cannot edit orders.');
      return;
    }
    const o = editTarget.order;
    const isTrigger = o.isTrigger || o.isPositionTpsl || o.tpsl === 'tp' || o.tpsl === 'sl';
    if (!isTrigger && editTarget.markPx != null && editTarget.markPx > 0) {
      const wouldTake = o.side === 'B' ? px >= editTarget.markPx : px <= editTarget.markPx;
      if (wouldTake) {
        setEditError('Post-only price would immediately take liquidity. Adjust price and try again.');
        return;
      }
    }
    setEditBusy(true);
    setEditError(null);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const ready = await ensureTradingReady({
        provider,
        userAddress: address as Hex,
        requiredFeeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });
      await modifyDeskOrder({
        agentPrivateKey: ready.agentPrivateKey,
        symbol: o.coin,
        oid: o.oid,
        side: o.side === 'B' ? 'buy' : 'sell',
        sizeUnits: size,
        limitPx: px,
        reduceOnly: o.reduceOnly || isTrigger,
        cloid: o.cloid,
        isTrigger,
        tpsl: o.tpsl,
        feeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
      });
      setEditTarget(null);
      notify({ kind: 'ok', message: `Order updated on ${displaySymbol(o.coin)}` });
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'openOrders', address] });
    } catch (e) {
      invalidateTradingReady(address as Hex);
      const msg = isWalletUserRejectedRequest(e)
        ? 'Wallet request was rejected.'
        : e instanceof Error
          ? e.message
          : 'Failed to modify order';
      setEditError(msg);
      notify({ kind: 'err', message: msg });
    } finally {
      setEditBusy(false);
    }
  };

  const archive = async () => {
    const token = await getAccessToken();
    if (!token) return;
    setBusy(true);
    try {
      const status: TenantPublic['status'] = tenant.status === 'archived' ? 'live' : 'archived';
      await patchTenant(tenant.slug, { status }, token);
      await qc.invalidateQueries({ queryKey: ['tenant', slug] });
      setArchiveConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const navItems = MARKET_NAV;

  return (
    <div className="min-h-dvh overflow-x-clip overscroll-x-none bg-sunken text-fg">
      <header className="flex h-14 min-w-0 items-center gap-2 overflow-x-clip border-b border-stroke-weak bg-background px-3 sm:h-[3.5rem] sm:gap-3 sm:px-4">
        <Link
          to={paths.home(tenant.slug)}
          className="flex min-w-0 items-center gap-2.5"
          title="Back to app page"
        >
          {tenant.logo_url ? (
            <img src={tenant.logo_url} alt="" className="h-7 w-7 shrink-0 rounded-[4px] object-cover" />
          ) : null}
          <span className="flex min-w-0 flex-col items-start justify-center gap-0.5">
            <span className="max-w-[10rem] truncate text-[14px] font-semibold leading-none tracking-tight sm:max-w-[16rem] sm:text-[15px]">
              {tenant.app_name}
            </span>
            <LiveDot on={market.connected} />
          </span>
        </Link>

        <div className="hidden sm:contents">
          <SocialLinks socials={tenant.socials} />
          <span className="hidden h-5 w-px shrink-0 bg-stroke-strong sm:block" aria-hidden />
          <ScrollFadeX className="min-w-0" fadeFrom="var(--bg-base)">
            <nav className="flex items-center gap-0.5 pr-2">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-bold text-fg-muted transition-colors hover:bg-fill-weak hover:text-fg sm:text-[14px]"
                  onClick={() => {
                    openPicker(item.id);
                  }}
                >
                  <item.Icon size={13} className="opacity-80" />
                  {item.label}
                </button>
              ))}
            </nav>
          </ScrollFadeX>
          {tenant.coin?.symbol ? (
            <>
              <span className="ml-2 hidden h-5 w-px shrink-0 bg-stroke-strong sm:block" aria-hidden />
              <Link
                to={paths.home(tenant.slug)}
                className="invest-cta ml-3 hidden shrink-0 sm:inline-flex"
                title={`Open ${tenant.coin.symbol} on the creator page`}
              >
                <span className="invest-cta-label">
                  Buy <span className="font-black">${tenant.coin.symbol}</span>
                </span>
              </Link>
            </>
          ) : null}
        </div>
        <span ref={streamSlotRef} className="ml-2 hidden shrink-0 items-center self-center sm:inline-flex" />

        <div className="ml-auto flex items-center gap-1.5 text-[11px] leading-none text-fg-muted sm:gap-2">
          <button
            type="button"
            onClick={() => setFeesOpen(true)}
            className="hidden rounded-md bg-brand-soft px-2 py-0.5 text-[10px] font-extrabold text-brand hover:opacity-90 sm:inline"
          >
            Fees
          </button>
          {authenticated ? (
            <>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="hidden h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-fill-weak hover:text-fg sm:inline-flex"
                aria-label="Trade settings"
                title="Trade settings"
              >
                <IconGear size={16} />
              </button>
              <WalletSheet compact hideRobinhood />
            </>
          ) : hydrating ? (
            <span>…</span>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              <Link to={loginHref()} className="btn-ghost btn-sm px-2.5 py-1 text-[11px]">
                Log in
              </Link>
              <Link to={loginHref()} className="btn-primary btn-sm px-2.5 py-1 text-[11px]">
                Sign up
              </Link>
            </div>
          )}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg hover:bg-fill-weak sm:hidden"
            aria-label="Open menu"
            onClick={() => setMobileMenuOpen(true)}
          >
            <IconMenu size={18} />
          </button>
        </div>
      </header>

      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-50 sm:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            aria-label="Close menu"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="absolute right-0 top-0 flex h-full w-[min(320px,88vw)] flex-col border-l border-stroke-weak bg-background shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-stroke-weak px-3">
              <span className="text-[14px] font-bold">Menu</span>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-fill-weak"
                aria-label="Close"
                onClick={() => setMobileMenuOpen(false)}
              >
                <IconClose size={18} />
              </button>
            </div>
            <div className="no-scrollbar flex-1 overflow-y-auto p-3">
              {tenant.coin?.symbol ? (
                <Link
                  to={paths.home(tenant.slug)}
                  className="invest-cta mb-3 flex w-full justify-center"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <span className="invest-cta-label">
                    Buy <span className="font-black">${tenant.coin.symbol}</span>
                  </span>
                </Link>
              ) : null}
              <nav className="flex flex-col gap-0.5">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="flex items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px] font-bold text-fg hover:bg-fill-weak"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      openPicker(item.id);
                    }}
                  >
                    <item.Icon size={15} className="opacity-80" />
                    {item.label}
                  </button>
                ))}
              </nav>
              <div className="mt-3 space-y-0.5 border-t border-stroke-weak pt-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px] font-bold text-fg hover:bg-fill-weak"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setFeesOpen(true);
                  }}
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-brand-soft text-[10px] font-extrabold text-brand">
                    $
                  </span>
                  Fees
                </button>
                {authenticated ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-3 text-left text-[14px] font-bold text-fg hover:bg-fill-weak"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    <IconGear size={15} className="opacity-80" />
                    Trade settings
                  </button>
                ) : null}
              </div>
              <div className="mt-4 border-t border-stroke-weak pt-3">
                <SocialLinks socials={tenant.socials} className="flex items-center gap-3 text-fg-subtle" />
                {tenant.status === 'live' && tenant.stream?.twitch && tenant.socials.twitch ? (
                  <StreamDockRestoreButton
                    slug={tenant.slug}
                    onShown={() => setMobileMenuOpen(false)}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ScrollFadeX className="border-b border-stroke-weak bg-background" fadeFrom="var(--bg-base)">
        <div className="flex items-center gap-6 px-3 sm:gap-8">
          <div className="flex shrink-0 items-center gap-2 py-1.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="shrink-0 rounded-md py-0.5 transition-colors hover:bg-fill-weak"
                onClick={() => openPicker('all')}
                aria-label="Change market"
              >
                {logo ? (
                  <img src={logo} alt="" className="h-7 w-7 rounded-full object-cover" />
                ) : (
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-[11px] font-black text-brand">
                    {(symbol || '?').slice(0, 1)}
                  </span>
                )}
              </button>
              <div className="flex flex-col items-start justify-center gap-0.5">
                <button
                  type="button"
                  className="group flex items-center gap-1 leading-none"
                  onClick={() => openPicker('all')}
                  aria-label="Change market"
                >
                  <span className="text-[16px] font-black tracking-tight text-fg sm:text-[18px]">{pairLabel}</span>
                  <IconChevron size={14} className="text-brand transition-transform group-hover:translate-y-px" />
                </button>
                <span className="sm:hidden">
                  <PerpSpotToggle
                    canSpot={canSpot}
                    isSpotOnly={!!selected?.isSpotOnly}
                    isSpotMode={isSpotMode}
                    onPerp={() => setMarketType('perp')}
                    onSpot={() => setMarketType('spot')}
                  />
                </span>
              </div>
            </div>
            <span className="hidden sm:inline-flex">
              <PerpSpotToggle
                canSpot={canSpot}
                isSpotOnly={!!selected?.isSpotOnly}
                isSpotMode={isSpotMode}
                onPerp={() => setMarketType('perp')}
                onSpot={() => setMarketType('spot')}
              />
            </span>
            {!isSpotMode && maxLev != null ? (
              <span className="shrink-0 rounded-md border border-brand/35 bg-brand-soft px-1.5 py-0.5 text-[11px] font-extrabold leading-none text-brand">
                {maxLev}x
              </span>
            ) : null}
          </div>

          <div className="hidden h-5 w-px shrink-0 bg-stroke-weak sm:block" />

          <div className="shrink-0 py-1.5">
            <span className="mr-1.5 text-[11px] text-fg-subtle">Mark</span>
            <RollingMark value={mark} className={`text-[15px] font-bold sm:text-[16px] ${chgClass(chg)}`} />
          </div>
          <Stat label="24h" value={formatPct(chg)} valueClass={chgClass(chg)} />
          <Stat label="Vol 24h" value={formatUsd(market.ctx?.dayNtlVlm)} />
          {!isSpotMode ? (
            <>
              <Stat label="OI" value={market.ctx?.openInterest != null ? formatPx(market.ctx.openInterest) : '—'} />
              <div className="shrink-0 py-1.5 pr-8">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Funding / Countdown</div>
                <div className="flex items-baseline gap-2 tabular text-[12px] font-semibold">
                  <span className={fundingClass(market.ctx?.funding)}>{formatFunding(market.ctx?.funding)}</span>
                  <span className="text-brand">{formatFundingCountdown(fundingLeftMs)}</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </ScrollFadeX>

      {/* Trade row fills the first viewport; account dock extends the page below (window scroll). */}
      <div className="grid grid-cols-1 overflow-x-clip lg:grid-cols-[minmax(0,1fr)_280px_320px]">
        <div
          className={`min-w-0 border-r border-stroke-weak border-b border-stroke-weak lg:border-b-0 ${
            chartOpen
              ? 'h-[min(420px,52svh)] min-h-[240px] lg:h-[min(780px,calc(100svh-104px))] lg:min-h-[420px]'
              : ''
          }`}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 border-b border-stroke-weak bg-background px-3 py-2 text-left text-[12px] font-bold lg:hidden"
            onClick={() => setChartOpen((o) => !o)}
          >
            <span>Chart · {symbol || '—'}</span>
            <IconChevron size={14} className={`text-fg-subtle transition-transform ${chartOpen ? 'rotate-180' : ''}`} />
          </button>
          {chartOpen ? (
            <div className="flex h-[calc(100%-2.5rem)] min-h-0 flex-col lg:h-full">
              {selected ? (
                <CandleChart
                  candles={market.candles}
                  interval={interval}
                  onInterval={(next) => {
                    saveChartInterval(next);
                    setInterval(next);
                  }}
                  symbol={symbol}
                  watermark={{ name: tenant.app_name, logoUrl: tenant.logo_url }}
                  lines={chartLines}
                />
              ) : (
                <p className="p-4 text-[13px] text-fg-subtle">No listed markets matched this catalog.</p>
              )}
            </div>
          ) : null}
        </div>
        <div
          className={`min-w-0 border-r border-stroke-weak border-b border-stroke-weak lg:border-b-0 ${
            bookOpen
              ? 'h-[480px] lg:h-[min(780px,calc(100svh-104px))] lg:min-h-[420px]'
              : ''
          }`}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 border-b border-stroke-weak bg-background px-3 py-2 text-left text-[12px] font-bold lg:hidden"
            onClick={() => setBookOpen((o) => !o)}
          >
            <span>Order book</span>
            <IconChevron size={14} className={`text-fg-subtle transition-transform ${bookOpen ? 'rotate-180' : ''}`} />
          </button>
          {bookOpen ? (
            <div className="h-[calc(100%-2.5rem)] min-h-0 lg:h-full">
              <OrderBook
                book={market.book}
                mark={mark}
                trades={market.trades}
                sizeUnit={symbol}
                onSigFigsChange={setBookSigFigs}
              />
            </div>
          ) : null}
        </div>
        <div className="h-[min(640px,85svh)] min-h-[28rem] min-w-0 border-b border-stroke-weak lg:h-[min(780px,calc(100svh-104px))] lg:min-h-[480px] lg:border-b-0">
          <OrderTicket
            coin={
              isSpotMode
                ? spotLookupName(selected?.coin ?? '', selected?.symbol)
                : (selected?.coin ?? '')
            }
            symbol={symbol || '—'}
            mark={mark}
            tenant={tenant}
            withdrawable={account.clearing?.withdrawable ?? null}
            accountValue={account.clearing?.accountValue ?? null}
            crossMaintenanceMarginUsed={account.clearing?.crossMaintenanceMarginUsed ?? null}
            abstractionMode={account.clearing?.abstractionMode ?? null}
            existing={
              selected
                ? (account.clearing?.positions.find((p) => p.coin === selected.coin) ?? null)
                : null
            }
            isHip3={selected?.isHip3}
            isSpotOnly={selected?.isSpotOnly}
            isSpotMode={isSpotMode}
            spotUsdcAvailable={spotUsdcAvailable}
            spotBaseAvailable={isSpotMode ? spotBaseAvailable : null}
            spotBaseCoin={spotBaseCoin}
            growthMode={!!selected?.growthMode}
            deployerFeeScale={
              selected?.deployerFeeScale == null ? null : Number(selected.deployerFeeScale)
            }
            onOpenFees={() => setFeesOpen(true)}
            onNotify={notify}
          />
        </div>
        <div
          ref={accountRef}
          className="h-[min(420px,48svh)] min-h-[300px] min-w-0 border-t border-stroke-weak lg:col-span-3"
        >
          <AccountDock
            address={address}
            catalog={tenant.catalog}
            assets={catalogQ.data ?? []}
            clearing={account.clearing}
            orders={account.orders}
            liveMarkCoin={selected?.coin ?? null}
            liveMarkPx={mark}
            selectedCoin={selected?.coin ?? null}
            resolveMarketCoin={(c) => resolveListedMarket(markets, c)?.coin ?? null}
            onSelectMarket={(next) => pickMarket(next)}
            canTrade={authenticated && tenant.status === 'live'}
            builderAddress={isOwner ? distinctBuilder : null}
            builderClearing={isOwner ? builderAccount.clearing : null}
            tenantBuilderAddress={tenant.builder_address}
            appName={tenant.app_name}
            closingCoin={closingCoin}
            closeError={closeError}
            confirmClose={(() => {
              void prefsTick;
              return getConfirmCloseOrders(address);
            })()}
            spotDusting={(() => {
              void prefsTick;
              return getSpotDusting(address);
            })()}
            onClosePosition={(p) => void closePosition(p)}
            onOpenTpsl={(p, markPx) => {
              const entrySide = p.szi > 0 ? 'long' : 'short';
              const existing = account.orders.filter(
                (o) => o.coin.toUpperCase() === p.coin.toUpperCase() && (o.tpsl === 'tp' || o.tpsl === 'sl'),
              );
              setTpslError(null);
              setTpslTarget({
                coin: p.coin,
                entrySide,
                entryPx: p.entryPx ?? markPx,
                markPx,
                sizeUnits: Math.abs(p.szi),
                existingTp: existing.find((o) => o.tpsl === 'tp')?.triggerPx ?? null,
                existingSl: existing.find((o) => o.tpsl === 'sl')?.triggerPx ?? null,
              });
            }}
            onSharePnl={(payload) => {
              setPnlShare({
                symbol: displaySymbol(payload.coin),
                direction: payload.direction,
                pnlPercent: payload.pnlPercent,
                entryPrice: payload.entryPrice,
                markPrice: payload.markPrice,
                leverage: payload.leverage,
                appName: tenant.app_name,
                logoUrl: tenant.logo_url || null,
              });
            }}
            cancellingOid={cancellingOid}
            cancelError={cancelError}
            onCancelOrder={(o) => void cancelOrder(o)}
            onEditOrder={openEditOrder}
          />
        </div>
      </div>

      <footer className="flex flex-col gap-2 border-t border-stroke-weak bg-background px-3 py-2.5 text-[11px] text-fg-subtle sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="min-w-0 font-semibold leading-5">
          © {new Date().getFullYear()} {tenant.app_name}{' '}
          <span className="font-medium">
            Trading involves risk. Not available in restricted jurisdictions.
          </span>
        </p>
        <nav className="flex shrink-0 items-center gap-3 font-bold text-fg-muted">
          {isOwner ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setArchiveConfirm(true)}
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em] disabled:opacity-50 ${
                tenant.status === 'archived'
                  ? 'border-brand/40 bg-brand-soft text-brand hover:bg-brand/15'
                  : 'border-stroke-strong bg-fill-weaker text-fg-muted hover:border-fg-subtle hover:text-fg'
              }`}
            >
              {tenant.status === 'archived' ? 'Restore app' : 'Archive app'}
            </button>
          ) : null}
          <Link to="/docs" className="hover:text-fg">
            Docs
          </Link>
          <Link to="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <Link to="/terms" className="hover:text-fg">
            Terms
          </Link>
        </nav>
      </footer>

      <SymbolPicker
        open={pickerOpen}
        markets={markets}
        selectedCoin={selected?.coin ?? null}
        initialTab={pickerTab}
        onClose={() => setPickerOpen(false)}
        onPick={pickMarket}
      />

      {feesOpen ? (
        <FeesSheet
          builderFeeTenths={tenant.builder_fee_tenths}
          buybackPct={tenant.buyback_pct ?? 0}
          burnPct={tenant.burn_pct ?? 0}
          assets={catalogQ.data ?? []}
          onClose={() => setFeesOpen(false)}
        />
      ) : null}

      {archiveConfirm ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onClick={() => !busy && setArchiveConfirm(false)}
        >
          <div
            role="dialog"
            aria-label={tenant.status === 'archived' ? 'Restore app' : 'Archive app'}
            className="w-full max-w-sm rounded-lg border border-stroke-weak bg-surface p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-extrabold text-fg">
              {tenant.status === 'archived' ? 'Restore this app?' : 'Archive this app?'}
            </h3>
            <p className="mt-2 text-[12px] leading-5 text-fg-muted">
              {tenant.status === 'archived'
                ? 'Restoring makes the trading terminal live again for visitors.'
                : 'Archiving disables new orders on this app. You can restore it later from My apps.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                className="btn-ghost btn-sm px-3 py-1.5 text-[12px]"
                onClick={() => setArchiveConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                className="btn-primary btn-sm px-3 py-1.5 text-[12px]"
                onClick={() => void archive()}
              >
                {busy ? 'Working…' : tenant.status === 'archived' ? 'Restore' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <TradeSettingsSheet
        open={settingsOpen}
        ownerId={address}
        onClose={() => {
          setSettingsOpen(false);
          setPrefsTick((n) => n + 1);
        }}
      />
      <PositionTpslSheet
        target={tpslTarget}
        busy={tpslBusy}
        error={tpslError}
        onClose={() => {
          if (!tpslBusy) {
            setTpslTarget(null);
            setTpslError(null);
          }
        }}
        onSubmit={(tp, sl) => void submitPositionTpsl(tp, sl)}
      />
      <EditOrderSheet
        target={editTarget}
        busy={editBusy}
        error={editError}
        onClose={() => {
          if (!editBusy) {
            setEditTarget(null);
            setEditError(null);
          }
        }}
        onSubmit={(px, sz) => void submitEditOrder(px, sz)}
      />
      <PnlShareModal payload={pnlShare} onClose={() => setPnlShare(null)} />
      <TradeToast toast={toast} onDismiss={dismissToast} />
      {tenant.status === 'live' && tenant.stream?.twitch && tenant.socials.twitch ? (
        <StreamDock slug={tenant.slug} channel={tenant.socials.twitch} slotRef={streamSlotRef} />
      ) : null}
    </div>
  );
}

/** Only Privy-verified handles reach the DB, so every icon here is the owner's. */
function SocialLinks({
  socials,
  className = 'hidden items-center gap-2 text-fg-subtle sm:flex',
}: {
  socials: TenantPublic['socials'];
  className?: string;
}) {
  const items: { href: string; title: string; Icon: typeof IconX }[] = [];
  if (socials.twitter) items.push({ href: `https://x.com/${socials.twitter}`, title: `@${socials.twitter} · verified`, Icon: IconX });
  if (socials.tiktok) items.push({ href: `https://www.tiktok.com/@${socials.tiktok}`, title: `@${socials.tiktok} · verified`, Icon: IconTikTok });
  if (socials.instagram) items.push({ href: `https://www.instagram.com/${socials.instagram}`, title: `@${socials.instagram} · verified`, Icon: IconInstagram });
  if (socials.youtube) items.push({ href: `https://www.youtube.com/@${socials.youtube}`, title: `${socials.youtube} · verified via Google`, Icon: IconYouTube });
  if (socials.twitch) items.push({ href: `https://www.twitch.tv/${socials.twitch}`, title: `${socials.twitch} · verified`, Icon: IconTwitch });
  if (socials.discord) items.push({ href: `https://discord.com/users/${socials.discord}`, title: `${socials.discord} · verified`, Icon: IconDiscord });
  if (socials.telegram) items.push({ href: `https://t.me/${socials.telegram}`, title: `@${socials.telegram} · verified`, Icon: IconTelegram });
  if (socials.website) {
    try {
      const href = normalizeWebsiteUrl(socials.website);
      if (href) items.push({ href, title: href, Icon: IconGlobe });
    } catch {
      /* skip unsafe legacy values */
    }
  }
  if (!items.length) return null;
  return (
    <span className={className}>
      {items.map(({ href, title, Icon }) => (
        <a key={href} href={href} target="_blank" rel="noreferrer" title={title} className="hover:text-fg">
          <Icon size={14} />
        </a>
      ))}
    </span>
  );
}

function RollingMark({ value, className }: { value: number | null; className?: string }) {
  const ready = value != null && Number.isFinite(value);
  const target = ready ? (value as number) : 0;
  const shown = useRollingNumber(target);
  if (!ready) return <span className={className}>—</span>;
  // Fixed decimals + reserved width so digit changes don't reflow the stats row.
  return (
    <span
      className={`inline-block min-w-[7.5ch] text-right tabular-nums ${className ?? ''}`}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {formatMarkStable(shown, target)}
    </span>
  );
}

function Stat({ label, value, valueClass = 'text-fg' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="shrink-0">
      <span className="mr-1.5 text-[11px] text-fg-subtle">{label}</span>
      <span className={`tabular text-[12px] font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

function LiveDot({ on }: { on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold leading-none text-fg-muted sm:text-[11px]">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${on ? 'animate-pulse bg-market-up' : 'bg-market-neutral'}`}
      />
      {on ? 'Live' : 'Reconnecting'}
    </span>
  );
}

function PerpSpotToggle({
  canSpot,
  isSpotOnly,
  isSpotMode,
  onPerp,
  onSpot,
}: {
  canSpot: boolean;
  isSpotOnly: boolean;
  isSpotMode: boolean;
  onPerp: () => void;
  onSpot: () => void;
}) {
  if (canSpot && !isSpotOnly) {
    return (
      <span className="flex items-center text-[11px] font-extrabold leading-none sm:text-[12px]">
        <button
          type="button"
          onClick={onPerp}
          className={`px-0.5 ${!isSpotMode ? 'text-fg' : 'text-fg-subtle hover:text-fg'}`}
        >
          Perp
        </button>
        <span className="font-semibold text-fg-subtle/35">/</span>
        <button
          type="button"
          onClick={onSpot}
          className={`px-0.5 ${isSpotMode ? 'text-brand' : 'text-fg-subtle hover:text-fg'}`}
        >
          Spot
        </button>
      </span>
    );
  }
  if (isSpotOnly) {
    return <span className="text-[11px] font-extrabold uppercase tracking-wide text-brand">Spot</span>;
  }
  return null;
}

function chgClass(chg: number | null): string {
  if (chg == null || chg === 0) return 'text-fg';
  return chg > 0 ? 'text-market-up' : 'text-market-down';
}

function fundingClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return 'text-fg';
  return v > 0 ? 'text-market-up' : 'text-market-down';
}

function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh items-start bg-sunken text-fg">
      <div className="p-6 text-[13px] text-fg-muted">{children}</div>
    </div>
  );
}
