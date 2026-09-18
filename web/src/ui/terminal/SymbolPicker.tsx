import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AssetRow } from '../../lib/tenants';
import {
  change24h,
  displaySymbol,
  formatPct,
  formatPx,
  formatUsd,
  num,
} from '../../lib/hlMarket';
import { midFromAllMids, useHlAllMids } from '../../lib/useHlAllMids';
import { quoteLogoSrc } from '../../lib/quoteLogos';
import { useMarketFavorites } from '../../lib/marketFavorites';
import { PICKER_TABS, type SymbolPickerTab } from '../../lib/marketNav';
import { IconChevron, IconClose, IconSearch, IconStar } from '../icons';
import { ScrollFadeX } from '../ScrollFadeX';

export type { SymbolPickerTab };

/** Curated spot-capable names (mirrors mobile SPOT_TOGGLE_WHITELIST). */
const SPOT_TAB_SYMBOLS = new Set([
  'BTC',
  'ETH',
  'HYPE',
  'SOL',
  'ZEC',
  'ENA',
  'MON',
  'XPL',
  'PUMP',
  'KNTQ',
  'USDT',
  'GOLDSPOT',
  'XAUT',
]);

type SortDir = 'high' | 'low';
type SortKey = 'change' | 'volume';

/** Recover prev-day px from the catalog snapshot so we can rebuild 24h % off a live mid. */
function impliedPrevDay(mark: number | null, changePct: number | null): number | null {
  if (mark == null || mark <= 0 || changePct == null || !Number.isFinite(changePct)) return null;
  const denom = 1 + changePct / 100;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;
  const prev = mark / denom;
  return prev > 0 && Number.isFinite(prev) ? prev : null;
}

function marketKind(a: AssetRow): 'spot' | 'stock' | 'crypto' | 'commodity' | 'index' | 'other' {
  const cat = (a.category || '').toLowerCase();
  if (a.isSpotOnly || cat === 'spot') return 'spot';
  if (cat === 'commodity') return 'commodity';
  if (cat === 'index') return 'index';
  if (cat === 'stock' || cat === 'equity' || cat === 'tradfi') return 'stock';
  if (cat === 'forex') return 'other';
  if (cat === 'crypto') return 'crypto';
  if (a.coin.includes(':')) return 'stock';
  return 'crypto';
}

function isSpotTabAsset(a: AssetRow): boolean {
  if (marketKind(a) === 'spot') return true;
  const base = displaySymbol(a.coin, a.symbol).toUpperCase();
  const sym = (a.symbol || '').toUpperCase();
  return SPOT_TAB_SYMBOLS.has(base) || SPOT_TAB_SYMBOLS.has(sym);
}

function matchScore(a: AssetRow, needle: string): number {
  const q = needle.toLowerCase();
  const sym = displaySymbol(a.coin, a.symbol).toLowerCase();
  const coin = a.coin.toLowerCase();
  const name = (a.name || '').toLowerCase();
  if (sym === q || coin === q) return 100;
  if (sym.startsWith(q) || coin.startsWith(q)) return 80;
  if (name.startsWith(q)) return 70;
  if (sym.includes(q) || coin.includes(q) || name.includes(q)) return 40;
  return 0;
}

function pairLabel(a: AssetRow): string {
  const base = displaySymbol(a.coin, a.symbol);
  return `${base}-USDC`;
}

function volumeOf(a: AssetRow): number {
  const v = num(a.dayNtlVlm);
  return v != null && Number.isFinite(v) ? v : 0;
}

export function SymbolPicker({
  open,
  markets,
  selectedCoin,
  initialTab = 'all',
  onClose,
  onPick,
}: {
  open: boolean;
  markets: AssetRow[];
  selectedCoin: string | null;
  initialTab?: SymbolPickerTab;
  onClose: () => void;
  onPick: (coin: string, opts?: { spot?: boolean }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SymbolPickerTab>(initialTab);
  const [active, setActive] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDir, setSortDir] = useState<SortDir>('high');
  const { isFavorite, toggleFavorite, favorites } = useMarketFavorites();
  const liveByCoin = useHlAllMids(open);

  const pricedMarkets = useMemo(() => {
    if (!liveByCoin.size) return markets;
    return markets.map((a) => {
      const live = midFromAllMids(liveByCoin, a.coin);
      if (live == null || live <= 0) return a;
      const catalogMark = num(a.markPx);
      const prev = impliedPrevDay(catalogMark, a.change24h ?? null);
      const chg = prev != null ? change24h(live, prev) : a.change24h;
      return {
        ...a,
        markPx: String(live),
        change24h: chg ?? a.change24h,
      };
    });
  }, [markets, liveByCoin]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'high' ? 'low' : 'high'));
    } else {
      setSortKey(key);
      setSortDir('high');
    }
  };

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setQuery('');
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const rows = useMemo(() => {
    let list = pricedMarkets;
    if (tab === 'favorites') {
      const set = new Set(favorites);
      list = pricedMarkets.filter((m) => set.has(m.coin));
    } else if (tab === 'spot') {
      list = pricedMarkets.filter((m) => isSpotTabAsset(m));
    } else if (tab === 'crypto') {
      list = pricedMarkets.filter((m) => marketKind(m) === 'crypto' && !m.isSpotOnly);
    } else if (tab === 'stocks') {
      list = pricedMarkets.filter((m) => marketKind(m) === 'stock');
    } else if (tab === 'commodities') {
      list = pricedMarkets.filter((m) => marketKind(m) === 'commodity');
    } else if (tab === 'index') {
      list = pricedMarkets.filter((m) => marketKind(m) === 'index');
    }

    const needle = query.trim();
    let filtered = list;
    if (needle) {
      filtered = list
        .map((a) => ({ a, score: matchScore(a, needle) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .map((x) => x.a);
    }

    return [...filtered].sort((a, b) => {
      const av = sortKey === 'volume' ? volumeOf(a) : (a.change24h ?? 0);
      const bv = sortKey === 'volume' ? volumeOf(b) : (b.change24h ?? 0);
      if (sortDir === 'high') return bv - av;
      return av - bv;
    });
  }, [pricedMarkets, tab, query, favorites, sortKey, sortDir]);

  useEffect(() => {
    setActive(0);
  }, [query, tab, sortKey, sortDir]);

  if (!open) return null;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      onPick(rows[active].coin, { spot: tab === 'spot' || rows[active].isSpotOnly });
    }
  };

  const tabs = PICKER_TABS;

  return (
    <div
      className="fixed inset-0 z-50 isolate flex items-stretch justify-center bg-black/80 sm:items-start sm:px-3 sm:pt-[max(3rem,6vh)]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search markets"
        className="flex h-full w-full max-h-none flex-col overflow-hidden rounded-none border-0 border-stroke-weak bg-background shadow-2xl ring-0 sm:h-auto sm:max-h-[min(78vh,640px)] sm:max-w-3xl sm:rounded-xl sm:border sm:ring-1 sm:ring-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative z-10 flex shrink-0 items-center gap-2 border-b border-stroke-weak bg-background px-3 py-2.5">
          <IconSearch size={15} className="shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold outline-none placeholder:text-fg-subtle sm:text-[14px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search markets"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="btn-ghost btn-sm p-1.5 text-fg-subtle" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>

        <ScrollFadeX className="shrink-0 border-b border-stroke-weak bg-background" fadeFrom="var(--bg-base)">
          <div className="flex gap-1 px-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-bold transition-colors ${
                  tab === t.id
                    ? 'border-[var(--text-brand)] text-brand'
                    : 'border-transparent text-fg-muted hover:text-fg'
                }`}
                onClick={() => setTab(t.id)}
              >
                <t.Icon size={12} filled={t.id === 'favorites' && tab === 'favorites'} />
                {t.label}
                {t.id === 'favorites' && favorites.length ? (
                  <span className="ml-0.5 text-[10px] text-fg-subtle">{favorites.length}</span>
                ) : null}
              </button>
            ))}
          </div>
        </ScrollFadeX>

        <div className="relative z-10 grid shrink-0 grid-cols-[minmax(0,1.5fr)_0.85fr_0.7fr] gap-2 border-b border-stroke-weak bg-background px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-fg-subtle sm:grid-cols-[minmax(0,1.6fr)_0.85fr_0.85fr_0.95fr]">
          <span>Market</span>
          <span className="text-right">Last</span>
          <button
            type="button"
            className={`inline-flex items-center justify-end gap-0.5 hover:text-fg ${
              sortKey === 'change' ? 'text-fg' : ''
            }`}
            onClick={() => toggleSort('change')}
            title={sortDir === 'high' ? 'Highest 24h change first' : 'Lowest 24h change first'}
          >
            <span className="sm:hidden">24h</span>
            <span className="hidden sm:inline">24h Change</span>
            <IconChevron
              size={11}
              className={`transition-transform ${
                sortKey === 'change' && sortDir === 'low' ? 'rotate-180' : ''
              } ${sortKey === 'change' ? 'opacity-100' : 'opacity-40'}`}
            />
          </button>
          <button
            type="button"
            className={`hidden items-center justify-end gap-0.5 hover:text-fg sm:inline-flex ${
              sortKey === 'volume' ? 'text-fg' : ''
            }`}
            onClick={() => toggleSort('volume')}
            title={sortDir === 'high' ? 'Highest volume first' : 'Lowest volume first'}
          >
            Volume
            <IconChevron
              size={11}
              className={`transition-transform ${
                sortKey === 'volume' && sortDir === 'low' ? 'rotate-180' : ''
              } ${sortKey === 'volume' ? 'opacity-100' : 'opacity-40'}`}
            />
          </button>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox">
          {!rows.length ? (
            <li className="px-4 py-10 text-center text-[13px] text-fg-subtle">
              {tab === 'favorites' ? 'Star markets to save them here.' : 'No markets match.'}
            </li>
          ) : (
            rows.map((a, i) => {
              const sym = displaySymbol(a.coin, a.symbol);
              const logo = quoteLogoSrc(sym);
              const chg = a.change24h ?? null;
              const px = num(a.markPx);
              const vol = volumeOf(a);
              const selected = selectedCoin === a.coin;
              const fav = isFavorite(a.coin);
              const activeRow = i === active;
              const lev =
                Number.isFinite(a.maxLeverage) && (a.maxLeverage as number) > 0
                  ? Math.floor(a.maxLeverage as number)
                  : null;
              return (
                <li key={a.coin} role="option" aria-selected={selected || activeRow}>
                  <div
                    className={`grid cursor-pointer grid-cols-[minmax(0,1.5fr)_0.85fr_0.7fr] items-center gap-2 px-2 py-2 text-[13px] sm:grid-cols-[minmax(0,1.6fr)_0.85fr_0.85fr_0.95fr] ${
                      selected || activeRow ? 'bg-brand-soft' : 'hover:bg-fill-hover'
                    }`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => onPick(a.coin, { spot: tab === 'spot' || a.isSpotOnly })}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        className={`shrink-0 rounded p-0.5 ${fav ? 'text-brand' : 'text-fg-subtle hover:text-brand'}`}
                        aria-label={fav ? 'Remove favorite' : 'Add favorite'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(a.coin);
                        }}
                      >
                        <IconStar size={14} filled={fav} />
                      </button>
                      {logo ? (
                        <img src={logo} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                      ) : (
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-fill-weak text-[10px] font-extrabold text-fg-subtle">
                          {sym.slice(0, 1)}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-extrabold text-fg">{pairLabel(a)}</span>
                          {tab === 'spot' || a.isSpotOnly ? (
                            <span className="shrink-0 rounded bg-brand-soft px-1 py-0.5 text-[10px] font-extrabold text-brand">
                              SPOT
                            </span>
                          ) : lev != null ? (
                            <span className="shrink-0 rounded bg-brand-soft px-1 py-0.5 text-[10px] font-extrabold text-brand">
                              {lev}x
                            </span>
                          ) : null}
                          {a.coin.includes(':') ? (
                            <span className="shrink-0 rounded bg-fill-weak px-1 py-0.5 text-[9px] font-bold uppercase text-fg-subtle">
                              {a.coin.split(':')[0]}
                            </span>
                          ) : null}
                        </span>
                        {a.name && a.name !== sym ? (
                          <span className="block truncate text-[11px] text-fg-subtle">{a.name}</span>
                        ) : null}
                      </span>
                    </div>
                    <span className="tabular text-right font-semibold text-fg">{formatPx(px)}</span>
                    <span
                      className={`tabular text-right font-semibold ${
                        chg == null || chg === 0 ? 'text-fg' : chg > 0 ? 'text-market-up' : 'text-market-down'
                      }`}
                    >
                      {formatPct(chg)}
                    </span>
                    <span className="hidden tabular text-right font-semibold text-fg-muted sm:block">
                      {vol > 0 ? formatUsd(vol) : '—'}
                    </span>
                  </div>
                </li>
              );
            })
          )}
        </ul>

        <div className="border-t border-stroke-weak bg-background px-3 py-1.5 text-[10px] text-fg-subtle">
          {rows.length} market{rows.length === 1 ? '' : 's'} · sorted by{' '}
          {sortKey === 'volume' ? 'volume' : '24h change'} {sortDir === 'high' ? 'highest' : 'lowest'}
        </div>
      </div>
    </div>
  );
}
