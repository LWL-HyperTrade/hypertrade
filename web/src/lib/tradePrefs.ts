/**
 * Web mirror of mobile `frontend/src/lib/leveragePrefs.ts`, plus order-ticket
 * last-used kind / size unit and terminal notification / confirm toggles.
 * localStorage keyed by trade wallet (or guest).
 */

const PREFS_KEY = 'builderpad:tradePrefs:hl';
const DEFAULT_LEVERAGE = 10;

export type MarginType = 'isolated' | 'cross';
export type OrderKind =
  | 'market'
  | 'limit'
  | 'stop_market'
  | 'stop_limit'
  | 'take_market'
  | 'take_limit';
export type SizeMode = 'usdc' | 'coin';
export type LimitTif = 'Gtc' | 'Ioc' | 'Alo';

export const ORDER_KINDS: readonly OrderKind[] = [
  'market',
  'limit',
  'stop_market',
  'stop_limit',
  'take_market',
  'take_limit',
];

export function isOrderKind(v: unknown): v is OrderKind {
  return typeof v === 'string' && (ORDER_KINDS as readonly string[]).includes(v);
}

type PerSymbolPrefs = {
  leverage?: number;
  marginType?: MarginType;
};

export type TradePrefs = {
  lastLeverage?: number;
  lastMarginType?: MarginType;
  lastOrderKind?: OrderKind;
  lastSizeMode?: SizeMode;
  lastTif?: LimitTif;
  /** Subtle success/error toasts after place / close. Default off. */
  orderNotifications?: boolean;
  /** Extra confirm before opening (market/limit) orders. Default on. */
  confirmOpenOrders?: boolean;
  /** Extra confirm before closing a position. Default on. */
  confirmCloseOrders?: boolean;
  /** Hide spot tokens worth under $0.10. Default on (matches HL Spot Dusting). */
  spotDusting?: boolean;
  bySymbol?: Record<string, PerSymbolPrefs>;
};

function storageKey(ownerId?: string | null): string {
  return `${PREFS_KEY}:${ownerId?.toLowerCase() ?? 'guest'}`;
}

function normSymbol(symbol: string | null | undefined): string {
  return String(symbol ?? '').toUpperCase();
}

function readPrefs(ownerId?: string | null): TradePrefs {
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TradePrefs;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePrefs(ownerId: string | null | undefined, prefs: TradePrefs) {
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify(prefs));
  } catch {
    /* quota / private mode */
  }
}

function patchPrefs(ownerId: string | null | undefined, patch: Partial<TradePrefs>) {
  writePrefs(ownerId, { ...readPrefs(ownerId), ...patch });
}

export function getSavedLeverage(
  ownerId: string | null | undefined,
  symbol: string,
  maxLeverage: number,
): number {
  const prefs = readPrefs(ownerId);
  const sym = normSymbol(symbol);
  const perAsset = sym ? prefs.bySymbol?.[sym]?.leverage : undefined;
  const lev = perAsset ?? prefs.lastLeverage ?? DEFAULT_LEVERAGE;
  return Math.min(Math.max(1, Math.floor(lev)), Math.max(1, maxLeverage));
}

export function saveLeverageForSymbol(
  ownerId: string | null | undefined,
  symbol: string,
  leverage: number,
) {
  const sym = normSymbol(symbol);
  if (!sym) return;
  const prefs = readPrefs(ownerId);
  prefs.bySymbol = { ...(prefs.bySymbol ?? {}) };
  prefs.bySymbol[sym] = { ...(prefs.bySymbol[sym] ?? {}), leverage };
  prefs.lastLeverage = leverage;
  writePrefs(ownerId, prefs);
}

/** Default cross when available (web terminal); falls back to isolated. */
export function getSavedMarginType(
  ownerId: string | null | undefined,
  symbol: string,
  supportsCross: boolean,
): MarginType {
  const prefs = readPrefs(ownerId);
  const sym = normSymbol(symbol);
  const perAsset = sym ? prefs.bySymbol?.[sym]?.marginType : undefined;
  const mt: MarginType = perAsset ?? prefs.lastMarginType ?? 'cross';
  if (!supportsCross && mt === 'cross') return 'isolated';
  return mt;
}

export function saveMarginTypeForSymbol(
  ownerId: string | null | undefined,
  symbol: string,
  marginType: MarginType,
  supportsCross: boolean,
) {
  const sym = normSymbol(symbol);
  if (!sym) return;
  const finalMarginType: MarginType =
    marginType === 'cross' && !supportsCross ? 'isolated' : marginType;
  const prefs = readPrefs(ownerId);
  prefs.bySymbol = { ...(prefs.bySymbol ?? {}) };
  prefs.bySymbol[sym] = { ...(prefs.bySymbol[sym] ?? {}), marginType: finalMarginType };
  prefs.lastMarginType = finalMarginType;
  writePrefs(ownerId, prefs);
}

export function getSavedOrderKind(ownerId?: string | null): OrderKind {
  const k = readPrefs(ownerId).lastOrderKind;
  return isOrderKind(k) ? k : 'market';
}

export function saveOrderKind(ownerId: string | null | undefined, kind: OrderKind) {
  const prefs = readPrefs(ownerId);
  prefs.lastOrderKind = kind;
  writePrefs(ownerId, prefs);
}

export function getSavedSizeMode(ownerId?: string | null): SizeMode {
  const m = readPrefs(ownerId).lastSizeMode;
  return m === 'coin' || m === 'usdc' ? m : 'usdc';
}

export function saveSizeMode(ownerId: string | null | undefined, mode: SizeMode) {
  const prefs = readPrefs(ownerId);
  prefs.lastSizeMode = mode;
  writePrefs(ownerId, prefs);
}

export function getSavedTif(ownerId?: string | null): LimitTif {
  const t = readPrefs(ownerId).lastTif;
  return t === 'Ioc' || t === 'Alo' || t === 'Gtc' ? t : 'Gtc';
}

export function saveTif(ownerId: string | null | undefined, tif: LimitTif) {
  const prefs = readPrefs(ownerId);
  prefs.lastTif = tif;
  writePrefs(ownerId, prefs);
}

export function getOrderNotifications(ownerId?: string | null): boolean {
  return readPrefs(ownerId).orderNotifications === true;
}

export function setOrderNotifications(ownerId: string | null | undefined, on: boolean) {
  patchPrefs(ownerId, { orderNotifications: on });
}

export function getConfirmOpenOrders(ownerId?: string | null): boolean {
  return readPrefs(ownerId).confirmOpenOrders !== false;
}

export function setConfirmOpenOrders(ownerId: string | null | undefined, on: boolean) {
  patchPrefs(ownerId, { confirmOpenOrders: on });
}

export function getConfirmCloseOrders(ownerId?: string | null): boolean {
  return readPrefs(ownerId).confirmCloseOrders !== false;
}

export function setConfirmCloseOrders(ownerId: string | null | undefined, on: boolean) {
  patchPrefs(ownerId, { confirmCloseOrders: on });
}

/** Hide spot holdings under this USD value when Spot Dusting is on. */
export const SPOT_DUST_USD = 0.1;

export function getSpotDusting(ownerId?: string | null): boolean {
  return readPrefs(ownerId).spotDusting !== false;
}

export function setSpotDusting(ownerId: string | null | undefined, on: boolean) {
  patchPrefs(ownerId, { spotDusting: on });
}
