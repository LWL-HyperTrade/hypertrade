import { useQuery } from '@tanstack/react-query';
import { fetchCryptoMetadata, fetchStockFundamentals, type StockFundamentals } from '../../lib/api';
import type { AssetRow } from '../../lib/tenants';
import { IconClose, IconExternal, IconX } from '../icons';

function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'TBA';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function count(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'TBA';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function num(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return 'TBA';
  return v.toFixed(digits);
}

function LinkBadge({
  href,
  label,
  icon,
  tone,
}: {
  href: string;
  label: string;
  icon?: React.ReactNode;
  tone: 'gold' | 'neutral';
}) {
  const toneClass =
    tone === 'gold'
      ? 'border-brand/35 bg-brand-soft text-brand'
      : 'border-stroke-weak bg-fill-weaker text-fg';
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-[13px] font-extrabold ${toneClass}`}
    >
      {icon ?? null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <IconExternal size={14} className="shrink-0 opacity-80" />
    </a>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-stroke-weak py-2">
      <span className="text-[12px] text-fg-subtle">{label}</span>
      <span className="text-right text-[13px] font-semibold tabular text-fg">{value}</span>
    </div>
  );
}

function stockRows(row: StockFundamentals, mark: number | null): Array<{ label: string; value: string }> {
  const shares = row.outstanding_shares;
  const cap =
    shares != null && mark != null && Number.isFinite(mark) && mark > 0 ? shares * mark : null;
  return [
    { label: 'Shares outstanding', value: count(shares) },
    { label: 'Market cap', value: money(cap) },
    { label: 'P/E', value: num(row.pe_ratio) },
    { label: 'EPS', value: row.eps == null ? 'TBA' : money(row.eps) },
    { label: '52w high', value: row.week52_high == null ? 'TBA' : money(row.week52_high) },
    { label: '52w low', value: row.week52_low == null ? 'TBA' : money(row.week52_low) },
    { label: 'Revenue', value: money(row.revenue) },
    { label: 'Net income', value: money(row.net_income) },
    { label: 'Gross profit', value: money(row.gross_profit) },
    { label: 'Operating income', value: money(row.operating_income) },
    { label: 'EBITDA', value: money(row.ebitda) },
    { label: 'Profit margin', value: row.profit_margin == null ? 'TBA' : `${num(row.profit_margin, 1)}%` },
    { label: 'Free cash flow', value: money(row.free_cash_flow) },
  ];
}

export function AssetInfoSheet({
  asset,
  mark,
  onClose,
}: {
  asset: AssetRow;
  mark: number | null;
  onClose: () => void;
}) {
  const symbol = (asset.symbol || asset.coin || '').trim();
  const isStock = asset.category === 'stock' || asset.category === 'equity' || asset.category === 'tradfi';
  const stockQ = useQuery({
    queryKey: ['stock-fundamentals', symbol],
    queryFn: () => fetchStockFundamentals(symbol),
    enabled: isStock && !!symbol,
    staleTime: 300_000,
    retry: false,
  });
  const cryptoQ = useQuery({
    queryKey: ['crypto-metadata', symbol],
    queryFn: () => fetchCryptoMetadata(symbol),
    enabled: !isStock && !!symbol,
    staleTime: 300_000,
    retry: false,
  });
  const loading = isStock ? stockQ.isLoading : cryptoQ.isLoading;
  const failed = isStock ? stockQ.isError : cryptoQ.isError;
  const description = (isStock ? stockQ.data?.description : cryptoQ.data?.description)?.trim() || '';
  const subtitle = isStock
    ? [symbol, stockQ.data?.industry].filter(Boolean).join(' — ')
    : [symbol, cryptoQ.data?.category].filter(Boolean).join(' — ');
  const circ = cryptoQ.data?.circulating_supply ?? null;
  const cap = circ != null && mark != null && mark > 0 ? circ * mark : null;
  const paper = cryptoQ.data?.whitepaper_url?.trim() || '';
  const paperOk = /^https:\/\//i.test(paper);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-3 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-md overflow-auto rounded-lg border border-stroke-weak bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${asset.name || symbol} info`}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-stroke-weak bg-surface px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-extrabold tracking-tight">{asset.name || symbol}</h2>
            <p className="mt-0.5 truncate text-[12px] text-fg-subtle">{subtitle || symbol}</p>
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-fill-hover hover:text-fg"
            aria-label="Close"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="px-4 py-4">
          {loading ? <p className="text-[13px] text-fg-subtle">Loading…</p> : null}
          {failed ? <p className="text-[13px] text-fg-subtle">Could not load this profile.</p> : null}
          {!loading && !failed && description ? (
            <p className="mb-3 text-[13px] leading-5 text-fg-muted">{description}</p>
          ) : null}
          {!loading && !failed && isStock ? (
            <div>
              <Row label="Next earnings" value={asset.nextEarnings || 'TBA'} />
              {stockRows(stockQ.data ?? emptyStock(symbol), mark).map((row) => (
                <Row key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          ) : null}
          {!loading && !failed && !isStock && cryptoQ.data ? (
            <div>
              <Row label="Circulating supply" value={count(circ)} />
              <Row label="Max supply" value={cryptoQ.data.max_supply == null ? '∞' : count(cryptoQ.data.max_supply)} />
              <Row label="Market cap" value={cap == null ? '—' : money(cap)} />
            </div>
          ) : null}
          {!loading && !failed && !isStock && !cryptoQ.data && !description ? (
            <p className="text-[13px] text-fg-subtle">No profile for this market yet.</p>
          ) : null}
          {!loading && !failed ? (
            <div className="mt-3 flex flex-col gap-2">
              {paperOk ? (
                <LinkBadge href={paper} label="View Whitepaper" tone="gold" />
              ) : null}
              {symbol ? (
                <LinkBadge
                  href={`https://x.com/search?q=${encodeURIComponent(`$${symbol.replace(/^\$+/, '').toUpperCase()}`)}`}
                  label={`Search $${symbol.replace(/^\$+/, '').toUpperCase()} on X`}
                  tone="neutral"
                  icon={<IconX size={14} />}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function emptyStock(symbol: string): StockFundamentals {
  return {
    symbol,
    description: null,
    sector: null,
    industry: null,
    outstanding_shares: null,
    pe_ratio: null,
    eps: null,
    revenue: null,
    net_income: null,
    gross_profit: null,
    operating_income: null,
    ebitda: null,
    profit_margin: null,
    free_cash_flow: null,
    week52_high: null,
    week52_low: null,
  };
}
