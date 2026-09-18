import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { loginHref, useWebAuth } from '../../lib/auth';
import { recordTenantOrder } from '../../lib/api';
import { type TenantPublic } from '../../lib/tenants';
import { formatFeePercent, totalTradingFees } from '../../lib/hip3Fees';
import {
  buildMaintenanceSchedule,
  estimateLiqPriceCross,
  estimateLiqPriceIsolated,
} from '../../lib/hlMargin';
import { formatPx, formatSz, formatUsd, type Clearinghouse } from '../../lib/hlMarket';
import {
  ensureTradingReady,
  getAssetIdAndMeta,
  invalidateTradingReady,
  isWalletUserRejectedRequest,
  placeDeskOrder,
  placeSpotDeskOrder,
  type Hex,
} from '../../lib/hlTrade';
import { useHlSetupStatus } from '../../lib/useHlAutoSetup';
import {
  getConfirmOpenOrders,
  getOrderNotifications,
  getSavedLeverage,
  getSavedMarginType,
  getSavedOrderKind,
  getSavedSizeMode,
  getSavedTif,
  saveLeverageForSymbol,
  saveMarginTypeForSymbol,
  saveOrderKind,
  saveSizeMode,
  saveTif,
  type LimitTif,
  type MarginType,
  type OrderKind,
  type SizeMode,
} from '../../lib/tradePrefs';
import { IconCheck, IconChevron } from '../icons';
import type { TradeToastPayload } from './TradeToast';

type Props = {
  coin: string;
  symbol: string;
  mark: number | null;
  tenant: TenantPublic;
  withdrawable: number | null;
  accountValue: number | null;
  crossMaintenanceMarginUsed: number | null;
  abstractionMode: string | null;
  existing: Clearinghouse['positions'][number] | null;
  isHip3?: boolean;
  isSpotOnly?: boolean;
  isSpotMode?: boolean;
  spotUsdcAvailable?: number | null;
  spotBaseAvailable?: number | null;
  spotBaseCoin?: string | null;
  growthMode?: boolean;
  deployerFeeScale?: number | null;
  onOpenFees?: () => void;
  onNotify?: (toast: TradeToastPayload) => void;
};

const LEV_CHIPS = [2, 3, 5, 10, 20, 40];
const TIF_OPTIONS: { id: LimitTif; label: string }[] = [
  { id: 'Gtc', label: 'GTC' },
  { id: 'Ioc', label: 'IOC' },
  { id: 'Alo', label: 'ALO' },
];

const KIND_LABEL: Record<OrderKind, string> = {
  market: 'Market',
  limit: 'Limit',
  stop_market: 'Stop Market',
  stop_limit: 'Stop Limit',
  take_market: 'Take Market',
  take_limit: 'Take Limit',
};

const PRO_KINDS: OrderKind[] = ['stop_market', 'stop_limit', 'take_market', 'take_limit'];

function isTriggerKind(k: OrderKind): boolean {
  return k === 'stop_market' || k === 'stop_limit' || k === 'take_market' || k === 'take_limit';
}

function isStopKind(k: OrderKind): boolean {
  return k === 'stop_market' || k === 'stop_limit';
}

function isLimitStyleKind(k: OrderKind): boolean {
  return k === 'limit' || k === 'stop_limit' || k === 'take_limit';
}

function triggerDirectionHint(kind: OrderKind, side: 'buy' | 'sell'): string | null {
  if (isStopKind(kind)) {
    return side === 'buy'
      ? 'Must be above mark for a stop buy'
      : 'Must be below mark for a stop sell';
  }
  if (kind === 'take_market' || kind === 'take_limit') {
    return side === 'buy'
      ? 'Must be below mark for a take buy'
      : 'Must be above mark for a take sell';
  }
  return null;
}

function clampLev(n: number, max: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), Math.max(1, max));
}

function safe(n: number | null | undefined): number {
  return Number.isFinite(n) ? (n as number) : 0;
}

function sliderFillStyle(filledPct: number): CSSProperties {
  const p = Math.max(0, Math.min(100, filledPct));
  return {
    background: `linear-gradient(to right, var(--text-brand) 0%, var(--text-brand) ${p}%, var(--stroke-weak) ${p}%, var(--stroke-weak) 100%)`,
  };
}

function placeLockTip(anchor: DOMRect) {
  const pad = 12;
  const width = Math.min(288, window.innerWidth - pad * 2);
  const left = Math.min(
    Math.max(pad, anchor.left + anchor.width / 2 - width / 2),
    window.innerWidth - width - pad,
  );
  return { top: anchor.bottom + 8, left, width };
}

function LockedBang({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 288 });
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || tipRef.current?.contains(t)) return;
      setOpen(false);
    };
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPos(placeLockTip(r));
    };
    place();
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative z-20 ml-0.5 inline-flex shrink-0">
      <button
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-warning/20 text-[9px] font-black leading-none text-warning"
        aria-label={note}
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = wrapRef.current?.getBoundingClientRect();
          if (r) setPos(placeLockTip(r));
          setOpen((v) => !v);
        }}
      >
        !
      </button>
      {open
        ? createPortal(
            <span
              ref={tipRef}
              role="tooltip"
              className="fixed z-[80] rounded-md border border-stroke-weak bg-overlay px-2.5 py-2 text-left text-[11px] font-semibold leading-4 text-fg shadow-lg"
              style={{ top: pos.top, left: pos.left, width: pos.width }}
            >
              {note}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

export function OrderTicket({
  coin,
  symbol,
  mark,
  tenant,
  withdrawable,
  accountValue,
  crossMaintenanceMarginUsed,
  abstractionMode,
  existing,
  isHip3: isHip3Prop,
  isSpotOnly,
  isSpotMode = false,
  spotUsdcAvailable = null,
  spotBaseAvailable = null,
  spotBaseCoin = null,
  growthMode,
  deployerFeeScale,
  onOpenFees,
  onNotify,
}: Props) {
  const { authenticated, address, builderAddress, getAccessToken, getEthereumProvider } = useWebAuth();
  const qc = useQueryClient();
  const setupQ = useHlSetupStatus(authenticated ? address : null);
  const ownerKey = address ?? null;
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<OrderKind>(() => getSavedOrderKind(ownerKey));
  const [size, setSize] = useState('');
  const [sizeMode, setSizeMode] = useState<SizeMode>(() => getSavedSizeMode(ownerKey));
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [price, setPrice] = useState('');
  const [triggerPx, setTriggerPx] = useState('');
  const [leverage, setLeverage] = useState(10);
  const [marginMode, setMarginMode] = useState<MarginType>('cross');
  const [pct, setPct] = useState(0);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<LimitTif>(() => getSavedTif(ownerKey));
  const [tifOpen, setTifOpen] = useState(false);
  const [proOpen, setProOpen] = useState(false);
  const [tpslOn, setTpslOn] = useState(false);
  const [tpPx, setTpPx] = useState('');
  const [slPx, setSlPx] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [levOpen, setLevOpen] = useState(false);
  const [unifyBusy, setUnifyBusy] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [triggerTouched, setTriggerTouched] = useState(false);

  const metaQ = useQuery({
    queryKey: ['hl', 'asset-meta', coin],
    enabled: !!coin && !isSpotMode,
    queryFn: () => getAssetIdAndMeta(coin),
    staleTime: 60_000,
  });

  const isHip3 = isHip3Prop ?? coin.includes(':');
  const pooled =
    abstractionMode === 'unifiedAccount' ||
    abstractionMode === 'portfolioMargin' ||
    !!setupQ.data?.accountMode;
  const maxLev = useMemo(() => {
    if (isSpotMode) return 1;
    const raw = metaQ.data?.maxLeverage;
    return Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : 20;
  }, [metaQ.data?.maxLeverage, isSpotMode]);
  const supportsCross = !isSpotMode && !!(metaQ.data?.supportsCross && (!isHip3 || pooled));
  const locked = !isSpotMode && existing != null;
  const effectiveMargin: MarginType = locked
    ? existing.marginType
    : supportsCross
      ? marginMode
      : 'isolated';
  const effectiveLev =
    isSpotMode
      ? 1
      : locked && existing.leverage != null
        ? clampLev(existing.leverage, maxLev)
        : clampLev(leverage, maxLev);
  const levFillPct = maxLev > 1 ? ((effectiveLev - 1) / (maxLev - 1)) * 100 : 0;
  const lockNote = locked
    ? `Locked to the open ${existing.marginType} ${existing.leverage ?? '—'}x position on this market.`
    : '';

  const fees = useMemo(
    () =>
      totalTradingFees(
        { coin, isHip3, isSpotOnly: isSpotMode, growthMode, deployerFeeScale },
        tenant.builder_fee_tenths,
      ),
    [coin, isHip3, isSpotOnly, isSpotMode, growthMode, deployerFeeScale, tenant.builder_fee_tenths],
  );

  useEffect(() => {
    setSize('');
    setPct(0);
    setError(null);
    setOk(null);
    setTpslOn(false);
    setTpPx('');
    setSlPx('');
    setPriceTouched(false);
    setPrice('');
    setTriggerTouched(false);
    setTriggerPx('');
    setConfirmPending(false);
    setProOpen(false);
  }, [coin, isSpotMode]);

  useEffect(() => {
    setConfirmPending(false);
  }, [side, kind, size, price, triggerPx, reduceOnly, tpslOn, tpPx, slPx]);

  // Restore last-used ticket prefs (order kind / size unit / tif are global;
  // leverage + margin follow mobile per-symbol + last-used fallback).
  useEffect(() => {
    setKind(getSavedOrderKind(ownerKey));
    setSizeMode(getSavedSizeMode(ownerKey));
    setTif(getSavedTif(ownerKey));
  }, [ownerKey]);

  useEffect(() => {
    if (locked) {
      setMarginMode(existing.marginType);
      if (existing.leverage != null) setLeverage(clampLev(existing.leverage, maxLev));
      return;
    }
    if (isSpotMode || !coin) return;
    // Wait for meta so supportsCross is known (HIP-3 + unified).
    if (!metaQ.data && !isSpotMode) return;
    setMarginMode(getSavedMarginType(ownerKey, coin, supportsCross));
    setLeverage(getSavedLeverage(ownerKey, coin, maxLev));
  }, [coin, ownerKey, supportsCross, locked, existing, maxLev, isSpotMode, metaQ.data]);

  useEffect(() => {
    if (kind === 'market') setTif('Gtc');
    if (isLimitStyleKind(kind)) setPriceTouched(false);
    if (isTriggerKind(kind)) {
      setTpslOn(false);
      setTpPx('');
      setSlPx('');
      setTriggerTouched(false);
    }
  }, [kind]);

  // Seed / refresh limit mid from the *current* asset only while untouched.
  useEffect(() => {
    if (!isLimitStyleKind(kind)) return;
    if (priceTouched) return;
    if (mark == null || !Number.isFinite(mark) || mark <= 0) return;
    setPrice(String(mark));
  }, [kind, mark, coin, priceTouched]);

  useEffect(() => {
    if (!isTriggerKind(kind)) return;
    if (triggerTouched) return;
    if (mark == null || !Number.isFinite(mark) || mark <= 0) return;
    setTriggerPx(String(mark));
  }, [kind, mark, coin, triggerTouched]);

  useEffect(() => {
    if (!isSpotMode) return;
    if (!isTriggerKind(kind)) return;
    setKind('market');
    saveOrderKind(ownerKey, 'market');
    setProOpen(false);
  }, [isSpotMode, kind, ownerKey]);

  useEffect(() => {
    if (locked || isSpotMode) return;
    if (!supportsCross && marginMode === 'cross') setMarginMode('isolated');
  }, [supportsCross, marginMode, locked, isSpotMode]);

  useEffect(() => {
    setLeverage((cur) => clampLev(cur, maxLev));
  }, [maxLev]);

  const setKindPersist = (next: OrderKind) => {
    setKind(next);
    saveOrderKind(ownerKey, next);
    setProOpen(false);
  };
  const setMarginPersist = (next: MarginType) => {
    setMarginMode(next);
    if (!coin || locked) return;
    saveMarginTypeForSymbol(ownerKey, coin, next, supportsCross);
  };
  const setLeveragePersist = (next: number) => {
    const n = clampLev(next, maxLev);
    setLeverage(n);
    if (!coin || locked || isSpotMode) return;
    saveLeverageForSymbol(ownerKey, coin, n);
  };
  const setSizeModePersist = (next: SizeMode) => {
    setSizeMode(next);
    saveSizeMode(ownerKey, next);
  };
  const setTifPersist = (next: LimitTif) => {
    setTif(next);
    saveTif(ownerKey, next);
  };

  useEffect(() => {
    if (!sizeMenuOpen && !levOpen && !tifOpen && !proOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-size-unit-menu]')) return;
      if (t?.closest?.('[data-lev-menu]')) return;
      if (t?.closest?.('[data-tif-menu]')) return;
      if (t?.closest?.('[data-pro-menu]')) return;
      setSizeMenuOpen(false);
      setLevOpen(false);
      setTifOpen(false);
      setProOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [sizeMenuOpen, levOpen, tifOpen, proOpen]);

  const isTrigger = isTriggerKind(kind);
  const isLimitStyle = isLimitStyleKind(kind);
  const refPx = isLimitStyle ? Number(price) || mark : mark;
  const sizeNum = Number(size);
  const sizeCoin =
    sizeMode === 'usdc'
      ? refPx && Number.isFinite(sizeNum) && sizeNum > 0
        ? sizeNum / refPx
        : NaN
      : sizeNum;
  const notional =
    Number.isFinite(sizeCoin) && sizeCoin > 0 && refPx && Number.isFinite(refPx)
      ? sizeCoin * refPx
      : null;
  const marginRequired = isSpotMode
    ? notional
    : notional != null
      ? notional / effectiveLev
      : null;

  const applyPct = (n: number, lev = effectiveLev) => {
    setPct(n);
    if (!refPx || refPx <= 0) {
      setSize('');
      return;
    }
    if (isSpotMode) {
      if (side === 'sell') {
        const base = Math.max(0, spotBaseAvailable ?? 0) * (n / 100);
        if (sizeMode === 'usdc') setSize(base * refPx > 0 ? (base * refPx).toPrecision(6) : '');
        else setSize(base > 0 ? base.toPrecision(6) : '');
        return;
      }
      const usd = Math.max(0, spotUsdcAvailable ?? 0) * (n / 100);
      if (sizeMode === 'usdc') setSize(usd > 0 ? usd.toPrecision(6) : '');
      else setSize(usd > 0 ? (usd / refPx).toPrecision(6) : '');
      return;
    }
    if (!withdrawable) {
      setSize('');
      return;
    }
    const buyingPower = withdrawable * lev;
    const usd = buyingPower * (n / 100);
    if (sizeMode === 'usdc') {
      setSize(usd > 0 ? usd.toPrecision(6) : '');
    } else {
      setSize(usd > 0 ? (usd / refPx).toPrecision(6) : '');
    }
  };

  const onSizeTyped = (raw: string) => {
    setSize(raw);
    const n = Number(raw);
    if (!refPx || refPx <= 0 || !Number.isFinite(n) || n <= 0) {
      setPct(0);
      return;
    }
    if (isSpotMode) {
      if (side === 'sell') {
        const base = Math.max(0, spotBaseAvailable ?? 0);
        if (base <= 0) {
          setPct(0);
          return;
        }
        const coinSz = sizeMode === 'usdc' ? n / refPx : n;
        setPct(Math.max(0, Math.min(100, (coinSz / base) * 100)));
        return;
      }
      const cap = Math.max(0, spotUsdcAvailable ?? 0);
      if (cap <= 0) {
        setPct(0);
        return;
      }
      const usd = sizeMode === 'usdc' ? n : n * refPx;
      setPct(Math.max(0, Math.min(100, (usd / cap) * 100)));
      return;
    }
    if (!withdrawable || withdrawable <= 0) {
      setPct(0);
      return;
    }
    const buyingPower = withdrawable * effectiveLev;
    if (buyingPower <= 0) {
      setPct(0);
      return;
    }
    const usd = sizeMode === 'usdc' ? n : n * refPx;
    setPct(Math.max(0, Math.min(100, (usd / buyingPower) * 100)));
  };

  const toggleSizeMode = (next: SizeMode) => {
    if (next === sizeMode) return;
    const px = refPx;
    const cur = Number(size);
    if (Number.isFinite(cur) && cur > 0 && px && px > 0) {
      if (next === 'usdc') setSize((cur * px).toPrecision(6));
      else setSize((cur / px).toPrecision(6));
    }
    setSizeModePersist(next);
  };

  const estLiqPx = useMemo(() => {
    if (isSpotMode) return null;
    const px = safe(refPx);
    const sz = safe(sizeCoin);
    if (px <= 0 || sz <= 0) return null;
    const schedule = buildMaintenanceSchedule([{ lowerBoundUsd: 0, maxLeverage: maxLev }]);
    if (!schedule.length) return null;

    const orderSzi = (side === 'buy' ? 1 : -1) * sz;
    const existingSzi = existing ? existing.szi : 0;
    const combinedSzi = existingSzi + orderSzi;
    const combinedAbs = Math.abs(combinedSzi);
    if (combinedAbs <= 0) return null;
    const combinedSide: 'long' | 'short' = combinedSzi >= 0 ? 'long' : 'short';

    let combinedEntry = px;
    if (existingSzi === 0) combinedEntry = px;
    else if (Math.sign(existingSzi) === Math.sign(orderSzi)) {
      combinedEntry =
        (Math.abs(existingSzi) * safe(existing?.entryPx) + Math.abs(orderSzi) * px) /
        Math.max(1e-9, combinedAbs);
    } else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
      combinedEntry = safe(existing?.entryPx) || px;
    } else if (Math.abs(orderSzi) > Math.abs(existingSzi)) {
      combinedEntry = px;
    }

    const existingNotional = Math.abs(existingSzi) * safe(existing?.entryPx || px);
    const existingLev = Math.max(1, safe(existing?.leverage ?? effectiveLev));
    const existingMargin =
      safe(existing?.marginUsed) > 0 ? safe(existing?.marginUsed) : existingNotional / existingLev;
    const orderNotional = Math.abs(orderSzi) * px;
    let totalIm = 0;
    if (existingSzi === 0) totalIm = orderNotional / effectiveLev;
    else if (Math.sign(existingSzi) === Math.sign(orderSzi)) totalIm = existingMargin + orderNotional / effectiveLev;
    else if (Math.abs(orderSzi) < Math.abs(existingSzi)) {
      totalIm =
        existingMargin *
        ((Math.abs(existingSzi) - Math.abs(orderSzi)) / Math.max(1e-9, Math.abs(existingSzi)));
    } else if (Math.abs(orderSzi) === Math.abs(existingSzi)) totalIm = 0;
    else totalIm = ((Math.abs(orderSzi) - Math.abs(existingSzi)) * px) / effectiveLev;

    const combinedNotional = combinedAbs * combinedEntry;
    const effectiveCombinedLev =
      totalIm > 0 ? Math.max(1, combinedNotional / totalIm) : effectiveLev;

    if (effectiveMargin === 'isolated') {
      return estimateLiqPriceIsolated({
        entryPx: combinedEntry,
        side: combinedSide,
        sizeUnits: combinedAbs,
        leverage: effectiveCombinedLev,
        schedule,
      });
    }

    return estimateLiqPriceCross({
      markPx: px,
      side: combinedSide,
      sizeUnits: combinedAbs,
      schedule,
      accountValueUsd: accountValue ?? undefined,
      crossMaintenanceMarginUsedUsd: crossMaintenanceMarginUsed ?? undefined,
      existing:
        existing && Math.abs(existing.szi) > 0 && safe(existing.liquidationPx) > 0
          ? {
              side: existing.szi >= 0 ? 'long' : 'short',
              sizeUnits: Math.abs(existing.szi),
              liquidationPx: safe(existing.liquidationPx),
              markPx: px,
            }
          : undefined,
    });
  }, [
    isSpotMode,
    refPx,
    sizeCoin,
    side,
    existing,
    effectiveLev,
    effectiveMargin,
    maxLev,
    accountValue,
    crossMaintenanceMarginUsed,
  ]);

  const live = tenant.status === 'live';
  const posSz = existing?.szi ?? 0;
  const triggerNum = Number(triggerPx);
  const limitNum = Number(price);
  const hasTrigger = Number.isFinite(triggerNum) && triggerNum > 0;
  const hasLimit = Number.isFinite(limitNum) && limitNum > 0;
  const canSubmit =
    authenticated &&
    live &&
    !!coin &&
    !!tenant.cloid_prefix &&
    Number.isFinite(sizeCoin) &&
    sizeCoin > 0 &&
    mark != null &&
    mark > 0 &&
    (!isLimitStyle || hasLimit) &&
    (!isTrigger || (!isSpotMode && hasTrigger));

  const submit = async () => {
    setError(null);
    setOk(null);
    if (!canSubmit || !address || mark == null) return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setError('Trade wallet required — builder wallet cannot place orders.');
      return;
    }
    if (notional != null && notional < 10) {
      setError(
        isSpotMode
          ? 'Order must have minimum value of $10.'
          : `Order must have minimum value of $10 (about $${(10 / effectiveLev).toFixed(2)} margin at ${effectiveLev}x).`,
      );
      return;
    }

    const entrySide = side === 'buy' ? 'long' : 'short';
    const entryPx = isLimitStyle ? Number(price) || mark : mark;
    if (isTrigger) {
      if (!hasTrigger) {
        setError('Enter a trigger price.');
        return;
      }
      if (isLimitStyle && !hasLimit) {
        setError('Enter a limit price.');
        return;
      }
      if (isStopKind(kind)) {
        if (entrySide === 'long' && triggerNum <= mark) {
          setError('Trigger must be above current price for stop buy orders');
          return;
        }
        if (entrySide === 'short' && triggerNum >= mark) {
          setError('Trigger must be below current price for stop sell orders');
          return;
        }
      } else {
        if (entrySide === 'long' && triggerNum >= mark) {
          setError('Trigger must be below current price for take buy orders');
          return;
        }
        if (entrySide === 'short' && triggerNum <= mark) {
          setError('Trigger must be above current price for take sell orders');
          return;
        }
      }
    }
    const tp = !isTrigger && tpslOn ? Number(tpPx) : NaN;
    const sl = !isTrigger && tpslOn ? Number(slPx) : NaN;
    const wantTp = !isTrigger && tpslOn && Number.isFinite(tp) && tp > 0;
    const wantSl = !isTrigger && tpslOn && Number.isFinite(sl) && sl > 0;
    if (!isTrigger && tpslOn && !wantTp && !wantSl) {
      setError('Enter a TP and/or SL price, or turn off Take Profit / Stop Loss.');
      return;
    }
    if (wantTp) {
      if (entrySide === 'long' && tp <= entryPx) {
        setError('Take profit must be above entry for a long.');
        return;
      }
      if (entrySide === 'short' && tp >= entryPx) {
        setError('Take profit must be below entry for a short.');
        return;
      }
    }
    if (wantSl) {
      if (entrySide === 'long' && sl >= entryPx) {
        setError('Stop loss must be below entry for a long.');
        return;
      }
      if (entrySide === 'short' && sl <= entryPx) {
        setError('Stop loss must be above entry for a short.');
        return;
      }
    }

    if (getConfirmOpenOrders(ownerKey) && !confirmPending) {
      setConfirmPending(true);
      return;
    }
    setConfirmPending(false);

    const notify = (toast: TradeToastPayload) => {
      if (!getOrderNotifications(ownerKey)) return;
      onNotify?.(toast);
    };

    setBusy(true);
    setStep('Preparing wallet');
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready. Sign in again.');
      const userAddress = address as Hex;
      const ready = await ensureTradingReady({
        provider,
        userAddress,
        requiredFeeTenths: tenant.builder_fee_tenths,
        builderAddress: tenant.builder_address,
        onStep: setStep,
      });
      setStep('Sending order');
      const result = isSpotMode
        ? await placeSpotDeskOrder({
            agentPrivateKey: ready.agentPrivateKey,
            symbol: coin,
            side,
            orderType: kind === 'limit' ? 'limit' : 'market',
            sizeCoin,
            oraclePx: mark,
            limitPx: kind === 'limit' ? Number(price) : undefined,
            feeTenths: tenant.builder_fee_tenths,
            cloidPrefix: tenant.cloid_prefix,
            builderAddress: tenant.builder_address,
            tif: kind === 'limit' ? tif : undefined,
          })
        : await placeDeskOrder({
            agentPrivateKey: ready.agentPrivateKey,
            userAddress,
            symbol: coin,
            side: entrySide,
            orderType: kind,
            sizeCoin,
            oraclePx: mark,
            limitPx: isLimitStyle ? Number(price) : undefined,
            triggerPx: isTrigger ? triggerNum : undefined,
            leverage: effectiveLev,
            marginMode: effectiveMargin,
            feeTenths: tenant.builder_fee_tenths,
            cloidPrefix: tenant.cloid_prefix,
            builderAddress: tenant.builder_address,
            reduceOnly,
            tif: kind === 'limit' ? tif : undefined,
            tpTriggerPx: wantTp ? tp : undefined,
            slTriggerPx: wantSl ? sl : undefined,
          });
      // HL has accepted. Attribution is best-effort and must not hold the
      // button busy — run it off the click path.
      void (async () => {
        try {
          const token = await getAccessToken();
          if (!token) return;
          await recordTenantOrder(
            tenant.slug,
            {
              cloid: result.cloid,
              oid: result.oid,
              symbol: coin,
              wallet_address: userAddress,
              notional_usd: notional,
              side,
              reduce_only: reduceOnly,
            },
            token,
          );
        } catch {
          // attribution is best-effort
        }
      })();

      setSize('');
      setPct(0);
      setTpslOn(false);
      setTpPx('');
      setSlPx('');
      setOk(null);
      setError(null);
      const label = KIND_LABEL[kind];
      notify({
        kind: 'ok',
        message: `${label} ${side === 'buy' ? 'buy' : 'sell'} submitted · ${symbol}`,
      });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'userFills', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'setup', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'historicalOrders', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'openOrders', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'userFills', address] });
      void qc.refetchQueries({ queryKey: ['hl', 'clearinghouse', address] });
    } catch (e) {
      // Re-verify agent / builder fee / unified on the next click; the
      // failure may be a revoked agent rather than a bad order.
      invalidateTradingReady(address as Hex);
      const msg = isWalletUserRejectedRequest(e)
        ? 'Wallet request was rejected.'
        : e instanceof Error
          ? e.message
          : 'Order failed';
      setError(msg);
      notify({ kind: 'err', message: msg });
    } finally {
      setBusy(false);
      setStep(null);
    }
  };

  const enableUnified = async () => {
    if (!address || unifyBusy) return;
    if (builderAddress && address.toLowerCase() === builderAddress.toLowerCase()) {
      setError('Trade wallet required — builder wallet stays on Standard.');
      return;
    }
    setUnifyBusy(true);
    setError(null);
    try {
      const provider = await getEthereumProvider();
      if (!provider) throw new Error('Wallet is not ready.');
      await ensureTradingReady({
        provider,
        userAddress: address as Hex,
        requiredFeeTenths: tenant.builder_fee_tenths,
        skipBuilderFee: true,
      });
      void qc.invalidateQueries({ queryKey: ['hl', 'setup', address] });
      void qc.invalidateQueries({ queryKey: ['hl', 'clearinghouse', address] });
    } catch (e) {
      if (isWalletUserRejectedRequest(e)) setError('Wallet request was rejected.');
      else setError(e instanceof Error ? e.message : 'Could not enable unified account');
    } finally {
      setUnifyBusy(false);
    }
  };

  const chips = LEV_CHIPS.filter((n) => n <= maxLev);
  if (!chips.includes(maxLev) && maxLev > 1) chips.push(maxLev);

  const mid = () => {
    if (mark != null) {
      setPriceTouched(false);
      setPrice(String(mark));
    }
  };

  const feeRate =
    kind === 'market' || kind === 'stop_market' || kind === 'take_market' || tif === 'Ioc'
      ? fees.taker
      : fees.maker;
  const estFeeUsd = notional != null ? notional * feeRate : null;

  const entryForTpsl = isLimitStyle ? Number(price) || mark : mark;
  const tpNum = Number(tpPx);
  const slNum = Number(slPx);
  const tpGain =
    tpslOn &&
    Number.isFinite(sizeCoin) &&
    sizeCoin > 0 &&
    entryForTpsl &&
    Number.isFinite(tpNum) &&
    tpNum > 0
      ? (side === 'buy' ? tpNum - entryForTpsl : entryForTpsl - tpNum) * sizeCoin
      : null;
  const slLoss =
    tpslOn &&
    Number.isFinite(sizeCoin) &&
    sizeCoin > 0 &&
    entryForTpsl &&
    Number.isFinite(slNum) &&
    slNum > 0
      ? (side === 'buy' ? slNum - entryForTpsl : entryForTpsl - slNum) * sizeCoin
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {!isSpotMode ? (
        <div className="relative grid shrink-0 grid-cols-3 gap-2 border-b border-stroke-weak p-2" data-lev-menu>
          {(['cross', 'isolated'] as const).map((m) => {
            const off = m === 'cross' && !supportsCross;
            const isActive = effectiveMargin === m;
            const showLockBang = locked && isActive;
            return (
              <div key={m} className="relative">
                <button
                  type="button"
                  disabled={off || locked}
                  onClick={() => setMarginPersist(m)}
                  title={off ? 'Cross not available on this market' : undefined}
                  className={`inline-flex w-full items-center justify-center gap-0.5 rounded-md py-2 text-[12px] font-bold capitalize disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive
                      ? 'bg-fill-hover text-fg ring-1 ring-stroke-strong'
                      : 'bg-fill-weak text-fg-muted hover:bg-fill-hover'
                  }`}
                >
                  {m === 'cross' ? 'Cross' : 'Isolated'}
                </button>
                {showLockBang ? (
                  <span className="absolute right-1 top-1/2 z-20 -translate-y-1/2">
                    <LockedBang note={lockNote} />
                  </span>
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            disabled={locked}
            onClick={() => setLevOpen((o) => !o)}
            title={locked ? lockNote : undefined}
            className="inline-flex items-center justify-center gap-0.5 rounded-md bg-fill-weak py-2 text-[12px] font-bold text-fg ring-1 ring-stroke-weak hover:bg-fill-hover disabled:opacity-40"
          >
            {effectiveLev}x
          </button>
          {levOpen && !locked ? (
            <div className="absolute left-2 right-2 top-full z-10 mt-1 rounded-md border border-stroke-weak bg-overlay p-2 shadow-lg">
              <div className="mb-2 grid grid-cols-3 gap-1">
                {chips.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setLeveragePersist(n);
                      if (pct > 0) applyPct(pct, n);
                      setLevOpen(false);
                    }}
                    className={`rounded-md py-1.5 text-[11px] font-bold ${
                      effectiveLev === n ? 'bg-brand-soft text-brand' : 'bg-fill-weak text-fg-muted hover:bg-fill-hover'
                    }`}
                  >
                    {n}x
                  </button>
                ))}
              </div>
              <input
                type="range"
                className="ticket-slider w-full"
                style={sliderFillStyle(levFillPct)}
                min={1}
                max={maxLev}
                step={1}
                value={effectiveLev}
                onChange={(e) => {
                  const next = clampLev(Number(e.target.value), maxLev);
                  setLeveragePersist(next);
                  if (pct > 0) applyPct(pct, next);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        className={`relative grid shrink-0 border-b border-stroke-weak ${isSpotMode ? 'grid-cols-2' : 'grid-cols-3'}`}
        data-pro-menu
      >
        {(['market', 'limit'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKindPersist(k)}
            className={`relative py-2.5 text-center text-[13px] font-bold capitalize ${
              kind === k ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {k}
            {kind === k ? <span className="absolute inset-x-4 -bottom-px h-[2px] rounded-full bg-brand" /> : null}
          </button>
        ))}
        {!isSpotMode ? (
          <>
            <button
              type="button"
              onClick={() => setProOpen((o) => !o)}
              className={`relative inline-flex items-center justify-center gap-0.5 py-2.5 text-[13px] font-bold ${
                isTrigger ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
              }`}
            >
              Pro
              <IconChevron size={12} className={`transition-transform ${proOpen ? 'rotate-180' : ''}`} />
              {isTrigger ? <span className="absolute inset-x-4 -bottom-px h-[2px] rounded-full bg-brand" /> : null}
            </button>
            {proOpen ? (
              <div className="absolute right-1 top-full z-20 mt-1 min-w-[11.5rem] overflow-hidden rounded-md border border-stroke-weak bg-overlay py-1 shadow-lg">
                {PRO_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKindPersist(k)}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] font-bold ${
                      kind === k ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                    }`}
                  >
                    {KIND_LABEL[k]}
                    {kind === k ? <IconCheck size={13} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5 pt-4 no-scrollbar">
        {isTrigger ? (
          <p className="-mt-1 text-[11px] font-extrabold text-brand">{KIND_LABEL[kind]}</p>
        ) : null}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setSide('buy')}
            className={`rounded-md py-2 text-[12px] font-extrabold ${
              side === 'buy' ? 'bg-market-up text-black' : 'bg-fill-weak text-fg-muted hover:bg-fill-hover'
            }`}
          >
            {isSpotMode ? 'Buy' : 'Buy / Long'}
          </button>
          <button
            type="button"
            onClick={() => setSide('sell')}
            className={`rounded-md py-2 text-[12px] font-extrabold ${
              side === 'sell' ? 'bg-market-down text-black' : 'bg-fill-weak text-fg-muted hover:bg-fill-hover'
            }`}
          >
            {isSpotMode ? 'Sell' : 'Sell / Short'}
          </button>
        </div>

        <div className="space-y-0.5 text-[11px] text-fg-subtle">
          <Row
            label="Available to Trade"
            value={
              isSpotMode
                ? side === 'sell'
                  ? `${spotBaseAvailable != null ? formatSz(spotBaseAvailable) : '0'} ${spotBaseCoin || symbol}`
                  : formatUsd(spotUsdcAvailable)
                : formatUsd(withdrawable)
            }
          />
          {!isSpotMode ? (
            <Row
              label="Current Position"
              value={`${Number.isFinite(posSz) ? Math.abs(posSz).toPrecision(6) : '0.00'} ${symbol}`}
            />
          ) : (
            <Row
              label="Spot balance"
              value={`${spotBaseAvailable != null ? formatSz(spotBaseAvailable) : '0'} ${spotBaseCoin || symbol}`}
            />
          )}
        </div>

        {isTrigger ? (
          <label className="block text-[11px] text-fg-subtle">
            Trigger Price
            <div className="relative mt-1">
              <input
                className="field w-full py-2 pr-12 text-[13px] tabular"
                value={triggerPx}
                onChange={(e) => {
                  setTriggerTouched(true);
                  setTriggerPx(e.target.value);
                }}
                placeholder={mark != null ? formatPx(mark) : '0.00'}
                inputMode="decimal"
              />
              <button
                type="button"
                onClick={() => {
                  if (mark != null) {
                    setTriggerTouched(false);
                    setTriggerPx(String(mark));
                  }
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-extrabold text-brand hover:underline"
              >
                Mid
              </button>
            </div>
            <span className="mt-1 block text-[10px] leading-4 text-fg-muted">
              {triggerDirectionHint(kind, side)}
            </span>
          </label>
        ) : null}

        {isLimitStyle ? (
          <label className="block text-[11px] text-fg-subtle">
            {kind === 'limit' ? 'Price (USDC)' : 'Limit Price'}
            <div className="relative mt-1">
              <input
                className="field w-full py-2 pr-12 text-[13px] tabular"
                value={price}
                onChange={(e) => {
                  setPriceTouched(true);
                  setPrice(e.target.value);
                }}
                placeholder={mark != null ? formatPx(mark) : '0.00'}
                inputMode="decimal"
              />
              <button
                type="button"
                onClick={mid}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-extrabold text-brand hover:underline"
              >
                Mid
              </button>
            </div>
          </label>
        ) : null}

        <label className="block text-[11px] text-fg-subtle">
          Size
          <div className="relative mt-1" data-size-unit-menu>
            <input
              className="field w-full py-2 pr-20 text-[13px] tabular"
              value={size}
              onChange={(e) => onSizeTyped(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
            />
            <button
              type="button"
              onClick={() => setSizeMenuOpen((o) => !o)}
              className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 text-[11px] font-extrabold text-brand"
            >
              {sizeMode === 'usdc' ? 'USDC' : symbol}
              <IconChevron
                size={12}
                className={`transition-transform ${sizeMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {sizeMenuOpen ? (
              <div className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[5.5rem] overflow-hidden rounded-md border border-stroke-weak bg-overlay py-1 shadow-lg">
                {(
                  [
                    ['usdc', 'USDC'],
                    ['coin', symbol],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      toggleSizeMode(id);
                      setSizeMenuOpen(false);
                    }}
                    className={`block w-full px-3 py-1.5 text-left text-[11px] font-bold ${
                      sizeMode === id ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </label>

        <div className="px-0.5 pt-1">
          <div className="mb-1 flex items-center justify-between gap-2">
            <input
              type="range"
              className="ticket-slider min-w-0 flex-1"
              style={sliderFillStyle(pct)}
              min={0}
              max={100}
              step={1}
              value={pct}
              onChange={(e) => applyPct(Number(e.target.value))}
            />
            <span className="shrink-0 rounded-md border border-stroke-weak bg-fill-weak px-1.5 py-0.5 tabular text-[10px] font-bold text-fg-muted">
              {Math.round(pct)}%
            </span>
          </div>
          <div className="flex justify-between text-[10px] text-fg-subtle">
            {[0, 25, 50, 75, 100].map((n) => (
              <button key={n} type="button" className="hover:text-fg" onClick={() => applyPct(n)}>
                {n}%
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-fg-muted">
          {!isSpotMode ? (
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={reduceOnly}
                onChange={(e) => setReduceOnly(e.target.checked)}
                className="accent-[var(--text-brand)]"
              />
              Reduce Only
            </label>
          ) : (
            <span />
          )}
          {kind === 'limit' ? (
            <div className="relative inline-flex items-center gap-1.5" data-tif-menu>
              <span className="text-fg-subtle underline decoration-dotted underline-offset-2">TIF</span>
              <button
                type="button"
                onClick={() => setTifOpen((o) => !o)}
                className="inline-flex items-center gap-0.5 rounded-md border border-stroke-weak bg-fill-weak px-2 py-0.5 text-[10px] font-extrabold text-fg"
              >
                {tif.toUpperCase()}
                <IconChevron size={11} className={`transition-transform ${tifOpen ? 'rotate-180' : ''}`} />
              </button>
              {tifOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 min-w-[4.5rem] overflow-hidden rounded-md border border-stroke-weak bg-overlay py-1 shadow-lg">
                  {TIF_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setTifPersist(opt.id);
                        setTifOpen(false);
                      }}
                      className={`block w-full px-3 py-1.5 text-left text-[11px] font-bold ${
                        tif === opt.id ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {!isSpotMode && !isTrigger ? (
          <div className="mb-1 space-y-2.5">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
              <input
                type="checkbox"
                checked={tpslOn}
                onChange={(e) => setTpslOn(e.target.checked)}
                className="accent-[var(--text-brand)]"
              />
              Take Profit / Stop Loss
            </label>
            {tpslOn ? (
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-bold text-fg-subtle">TP Price</span>
                  <input
                    className="field w-full py-1.5 text-[12px]"
                    inputMode="decimal"
                    value={tpPx}
                    onChange={(e) => setTpPx(e.target.value)}
                    placeholder={mark != null ? String(mark) : '0'}
                  />
                  <span className="mt-2 block text-[10px] leading-4 text-fg-subtle">
                    Gain {tpGain != null && Number.isFinite(tpGain) ? formatUsd(tpGain) : '—'}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] font-bold text-fg-subtle">SL Price</span>
                  <input
                    className="field w-full py-1.5 text-[12px]"
                    inputMode="decimal"
                    value={slPx}
                    onChange={(e) => setSlPx(e.target.value)}
                    placeholder={mark != null ? String(mark) : '0'}
                  />
                  <span className="mt-2 block text-[10px] leading-4 text-fg-subtle">
                    Loss {slLoss != null && Number.isFinite(slLoss) ? formatUsd(slLoss) : '—'}
                  </span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {!isSpotMode && !supportsCross && isHip3 && !pooled ? (
          <div className="space-y-1 text-[10px] leading-4 text-fg-subtle">
            <p>
              HIP-3 cross needs a unified trade wallet (HD0). Builder wallet (HD1) stays Standard and is never used to
              trade here.
            </p>
            {authenticated ? (
              <button
                type="button"
                disabled={unifyBusy}
                onClick={() => void enableUnified()}
                className="font-extrabold text-brand hover:underline disabled:opacity-50"
              >
                {unifyBusy ? 'Enabling…' : 'Enable unified on trade wallet'}
              </button>
            ) : null}
          </div>
        ) : null}

        {!authenticated ? (
          <Link
            to={loginHref()}
            className={`mt-auto block rounded-md py-2.5 text-center text-[13px] font-extrabold ${
              side === 'buy' ? 'bg-market-up text-black' : 'bg-market-down text-black'
            }`}
          >
            Log in to trade
          </Link>
        ) : confirmPending ? (
          <div className="mt-auto grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmPending(false)}
              className="rounded-md bg-fill-weak py-2.5 text-[13px] font-extrabold text-fg hover:bg-fill-hover disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !canSubmit}
              onClick={() => void submit()}
              className={`rounded-md py-2.5 text-[13px] font-extrabold disabled:cursor-not-allowed disabled:opacity-45 ${
                side === 'buy' ? 'bg-market-up text-black' : 'bg-market-down text-black'
              }`}
            >
              {busy ? step || 'Working…' : 'Confirm'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
            className={`mt-auto rounded-md py-2.5 text-[13px] font-extrabold disabled:cursor-not-allowed disabled:opacity-45 ${
              side === 'buy' ? 'bg-market-up text-black' : 'bg-market-down text-black'
            }`}
          >
            {busy ? step || 'Working…' : `${isSpotMode ? (side === 'buy' ? 'Buy' : 'Sell') : side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}
          </button>
        )}

        <div className="space-y-0.5 text-[11px] text-fg-subtle">
          {!isSpotMode ? (
            <>
              <Row label="Liquidation Price" value={estLiqPx != null ? formatPx(estLiqPx) : 'N/A'} />
              <Row label="Margin Required" value={formatUsd(marginRequired)} />
            </>
          ) : null}
          <Row label="Order Value" value={formatUsd(notional)} />
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span>
              Fees{' '}
              <span className="tabular text-fg">
                {formatFeePercent(feeRate)}
                {estFeeUsd != null ? ` · ${formatUsd(estFeeUsd)}` : ''}
              </span>
            </span>
            {onOpenFees ? (
              <button
                type="button"
                onClick={onOpenFees}
                className="rounded-md px-1.5 py-0.5 text-[10px] font-extrabold text-brand hover:bg-brand-soft"
              >
                Details
              </button>
            ) : null}
          </div>
        </div>

        {!live ? (
          <p className="text-[10px] leading-4 text-warning">This app is archived. Orders are disabled.</p>
        ) : null}
        {ok ? <p className="text-[11px] text-market-up">{ok}</p> : null}
        {error ? <p className="text-[11px] text-market-down">{error}</p> : null}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className="tabular text-fg">{value}</span>
    </div>
  );
}
