import { formatPx, formatSz, type TapeTrade } from '../../lib/hlMarket';

export function TradeTape({ trades }: { trades: TapeTrade[] }) {
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-stroke-weak bg-background">
      <div className="grid shrink-0 grid-cols-3 border-b border-stroke-weak px-2 py-1 text-[10px] uppercase tracking-wide text-fg-subtle">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Time</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {trades.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-fg-subtle">Waiting for prints…</p>
        ) : (
          trades.map((t) => (
            <div
              key={t.key}
              className={`grid grid-cols-3 px-2 py-[2px] text-[11px] leading-4 ${
                t.side === 'B' ? 'tape-buy' : 'tape-sell'
              }`}
            >
              <span className={`tabular ${t.side === 'B' ? 'text-market-up' : 'text-market-down'}`}>
                {formatPx(t.px)}
              </span>
              <span className="tabular text-right text-fg">{formatSz(t.sz)}</span>
              <span className="tabular text-right text-fg-subtle">{clock(t.time)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
