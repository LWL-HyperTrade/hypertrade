/**
 * Price lines for the trade chart — same set as mobile `AssetChart`:
 * position entry (colored by live PnL, label "Avg.") + liquidation,
 * TP / SL triggers, resting limit orders. Pure data; the KLine renderer
 * lives in `klineLines.ts`.
 */
import { formatPx, type Clearinghouse, type OpenOrder } from './hlMarket';

export type ChartLineKind = 'entry' | 'liq' | 'tp' | 'sl' | 'buy' | 'sell';

export type ChartPriceLine = {
  /** Stable id so the renderer can update in place instead of flickering. */
  id: string;
  kind: ChartLineKind;
  price: number;
  /** Short right-edge tag. Keep it terse — it sits over candles. */
  label: string;
  color: string;
  dashed: boolean;
};

const UP = '#77c7af';
const DOWN = '#ff9c9c';
const LIQ = '#ff9c9c';
const MUTED = '#ffffff99';

type Position = Clearinghouse['positions'][number];

function sameCoin(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Entry color by live mark vs entry — same idea as mobile `entryLineColor`. */
function entryColor(pos: Position, mark: number | null): string {
  const entry = pos.entryPx;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return MUTED;
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return MUTED;
  const isLong = pos.szi >= 0;
  if (isLong) return mark >= entry ? UP : DOWN;
  return mark <= entry ? UP : DOWN;
}

/** Build lines for the chart's coin. Spot has no positions; caller passes [] there. */
export function buildChartLines(args: {
  coin: string;
  positions: Clearinghouse['positions'] | null | undefined;
  orders: OpenOrder[] | null | undefined;
  mark: number | null;
}): ChartPriceLine[] {
  const out: ChartPriceLine[] = [];
  if (!args.coin) return out;

  const pos = (args.positions ?? []).find((p) => sameCoin(p.coin, args.coin) && p.szi !== 0);
  if (pos && pos.entryPx != null && Number.isFinite(pos.entryPx) && pos.entryPx > 0) {
    out.push({
      id: 'entry',
      kind: 'entry',
      price: pos.entryPx,
      label: 'Avg.',
      color: entryColor(pos, args.mark),
      dashed: false,
    });
    if (pos.liquidationPx != null && Number.isFinite(pos.liquidationPx) && pos.liquidationPx > 0) {
      out.push({
        id: 'liq',
        kind: 'liq',
        price: pos.liquidationPx,
        label: `Liq ${formatPx(pos.liquidationPx)}`,
        color: LIQ,
        dashed: true,
      });
    }
  }

  for (const o of args.orders ?? []) {
    if (!sameCoin(o.coin, args.coin)) continue;
    const isTpsl = o.tpsl === 'tp' || o.tpsl === 'sl';
    const trigger = o.isTrigger || isTpsl || (o.triggerPx != null && o.triggerPx > 0);
    const px = trigger && o.triggerPx != null && o.triggerPx > 0 ? o.triggerPx : o.limitPx;
    if (!Number.isFinite(px) || px <= 0) continue;
    const isBuy = o.side === 'B';
    if (isTpsl) {
      const tp = o.tpsl === 'tp';
      out.push({
        id: `o${o.oid}`,
        kind: tp ? 'tp' : 'sl',
        price: px,
        label: `${tp ? 'TP' : 'SL'} ${formatPx(px)}`,
        color: tp ? UP : DOWN,
        dashed: true,
      });
      continue;
    }
    out.push({
      id: `o${o.oid}`,
      kind: isBuy ? 'buy' : 'sell',
      price: px,
      label: `${trigger ? 'Stop ' : ''}${isBuy ? 'Buy' : 'Sell'} ${formatPx(px)}`,
      color: isBuy ? UP : DOWN,
      dashed: true,
    });
  }
  return out;
}
