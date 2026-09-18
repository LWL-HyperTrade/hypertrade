/**
 * KLine renderer for `ChartPriceLine[]` (entry / liq / TP / SL / limits).
 *
 * One locked, event-transparent overlay holds *all* lines as points, so the
 * layout runs on every draw with live pixel coordinates — tag stacking stays
 * correct while the user zooms / scrolls the price scale. Lines always sit on
 * their true price; only the tag moves when two would collide, and an elbow
 * leader ties the displaced tag back to its line. Tags are right-aligned and
 * each hugs its own label; the column is reserved at the widest label so every
 * line ends at the same x regardless of label length.
 */
import { registerOverlay, utils, type Chart, type OverlayFigure } from 'klinecharts';
import type { ChartPriceLine } from './chartLines';

export const PRICE_LINE_OVERLAY = 'ht_price_lines';
export const PRICE_LINE_GROUP = 'ht_price_lines';
const OVERLAY_ID = `${PRICE_LINE_GROUP}_all`;

const FONT = '"Basel Grotesk", Basel, Inter, ui-sans-serif, system-ui, sans-serif';
/** Line alpha — visible, but candles stay the subject. */
const LINE_ALPHA = 'bb';
const TAG_BG = '#12131aee';
const TAG_FONT_SIZE = 10;
const TAG_FONT_WEIGHT = 600;
const TAG_PAD_X = 5;
const TAG_PAD_Y = 2;
/** Drawn tag box height. */
const TAG_BOX_H = TAG_FONT_SIZE + TAG_PAD_Y * 2 + 2;
/** Tag box height + breathing room; used for collision spacing. */
const TAG_H = TAG_BOX_H + 3;
/** Keep stacked tags inside the pane by this much. */
const EDGE_PAD = 8;
/** Gap between the end of the price line and the tag column. */
const TAG_GAP = 8;
/** Right inset of the tag column from the pane edge. */
const RIGHT_INSET = 2;
/** Long dash / short gap reads as one calm rule instead of a dotted texture. */
const DASH: [number, number] = [6, 4];

let registered = false;

/** Tag width for a label, including horizontal padding. */
function tagWidth(label: string): number {
  return Math.ceil(utils.calcTextWidth(label, TAG_FONT_SIZE, TAG_FONT_WEIGHT, FONT)) + TAG_PAD_X * 2;
}

/**
 * Tag y for each line. A tag stays exactly on its line unless (a) it would
 * overlap a neighbour or (b) it would hang off the pane edge. Only the tags
 * involved move; a Liq near the top never displaces an Avg in the middle.
 * Colliding tags form a cluster that is re-centred on its own lines so the
 * displacement is shared above and below, then bounded by the pane and by the
 * neighbouring clusters so re-centring can never create a new overlap.
 */
function layoutTagY(ys: number[], height: number): number[] {
  const n = ys.length;
  if (!n || height <= 0) return ys.slice();
  const minY = EDGE_PAD + TAG_H / 2;
  const maxY = height - EDGE_PAD - TAG_H / 2;
  const clampEdge = (v: number) => Math.min(maxY, Math.max(minY, v));

  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  // Each tag's own wish: its line, kept inside the pane.
  const want = order.map((i) => clampEdge(ys[i]));
  // Forward pass: push down only when colliding with the tag above.
  const pos = want.slice();
  for (let k = 1; k < n; k++) pos[k] = Math.max(want[k], pos[k - 1] + TAG_H);
  // Too many tags at the bottom: walk back up from the floor.
  if (pos[n - 1] > maxY) {
    pos[n - 1] = maxY;
    for (let k = n - 2; k >= 0; k--) pos[k] = Math.min(pos[k], pos[k + 1] - TAG_H);
  }
  // Re-centre each collided cluster on its lines, bounded so it neither leaves
  // the pane nor touches the cluster above / below.
  let start = 0;
  while (start < n) {
    let end = start + 1;
    while (end < n && pos[end] - pos[end - 1] < TAG_H + 0.5) end += 1;
    if (end - start > 1) {
      let meanLine = 0;
      let meanTag = 0;
      for (let k = start; k < end; k++) {
        meanLine += want[k];
        meanTag += pos[k];
      }
      let shift = (meanLine - meanTag) / (end - start);
      const lo = Math.max(minY, start > 0 ? pos[start - 1] + TAG_H : -Infinity) - pos[start];
      const hi = Math.min(maxY, end < n ? pos[end] - TAG_H : Infinity) - pos[end - 1];
      shift = Math.min(hi, Math.max(lo, shift));
      for (let k = start; k < end; k++) pos[k] += shift;
    }
    start = end;
  }
  const out: number[] = new Array(n);
  order.forEach((i, k) => {
    out[i] = Math.round(pos[k]);
  });
  return out;
}

export function ensureKlinePriceLineOverlay(): void {
  if (registered) return;
  registered = true;
  registerOverlay<ChartPriceLine[]>({
    name: PRICE_LINE_OVERLAY,
    totalStep: 2,
    lock: true,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const lines = overlay.extendData;
      if (!Array.isArray(lines) || !lines.length) return [];
      const height = bounding.height;

      // Visible lines only, snapped to whole pixels — a 1px stroke on a
      // fractional row anti-aliases into two faint rows and the dash pattern
      // looks uneven (worse at DPR 2–3).
      const visible: { line: ChartPriceLine; y: number }[] = [];
      lines.forEach((line, i) => {
        const raw = coordinates[i]?.y;
        if (raw == null || !Number.isFinite(raw)) return;
        if (raw < 0 || raw > height) return;
        visible.push({ line, y: Math.round(raw) });
      });
      if (!visible.length) return [];

      // Tags are right-aligned and each box hugs its own label ("Avg" is not
      // padded out to "Liq 78,406.40"). The column is still reserved at the
      // widest label so every price line ends at the same x; a leader bridges
      // the line end to the box edge of *its* tag.
      const widths = visible.map((v) => tagWidth(v.line.label));
      const colW = Math.max(...widths);
      const xRight = bounding.width - RIGHT_INSET;
      const xColLeft = Math.max(0, Math.round(xRight - colW));
      const xLineEnd = Math.max(0, xColLeft - TAG_GAP);
      // Vertical leg of a leader sits in the gap, midway between line end and column.
      const xLeader = Math.round((xLineEnd + xColLeft) / 2) + 0.5;
      const tagLeft = (i: number) => Math.max(xColLeft, Math.round(xRight - widths[i]));

      const tagYs = layoutTagY(
        visible.map((v) => v.y),
        height,
      );

      const figures: OverlayFigure[] = [];
      visible.forEach(({ line, y }, i) => {
        const color = line.color.length === 7 ? `${line.color}${LINE_ALPHA}` : line.color;
        const tagY = tagYs[i];
        // Draw right→left so the dash phase is anchored at the line end: every
        // line finishes with a full dash at the same x, regardless of width.
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: xLineEnd, y }, { x: 0, y }] },
          styles: {
            style: line.dashed ? 'dashed' : 'solid',
            dashedValue: DASH,
            size: 1,
            color,
          },
          ignoreEvent: true,
        });
        const xTag = tagLeft(i);
        if (Math.abs(tagY - y) > 1) {
          // Elbow: stub into the gap, vertical run, then across to this tag's own edge.
          figures.push({
            type: 'line',
            attrs: {
              coordinates: [
                { x: xLineEnd, y },
                { x: xLeader, y },
                { x: xLeader, y: tagY },
                { x: xTag, y: tagY },
              ],
            },
            styles: { style: 'solid', size: 1, color },
            ignoreEvent: true,
          });
        } else if (xTag > xColLeft) {
          // Tag sits on its line but is narrower than the column: extend the
          // solid stub so the line visibly reaches the box (no floating gap).
          figures.push({
            type: 'line',
            attrs: { coordinates: [{ x: xLineEnd, y }, { x: xTag, y }] },
            styles: { style: 'solid', size: 1, color },
            ignoreEvent: true,
          });
        }
      });

      // Tags after lines so they paint on top of any neighbour's leader.
      visible.forEach(({ line }, i) => {
        const tagY = tagYs[i];
        const xTag = tagLeft(i);
        figures.push({
          type: 'rect',
          attrs: { x: xTag, y: tagY - TAG_BOX_H / 2, width: xRight - xTag, height: TAG_BOX_H },
          styles: { style: 'fill', color: TAG_BG, borderRadius: 3, borderSize: 0 },
          ignoreEvent: true,
        });
        figures.push({
          type: 'text',
          attrs: {
            x: xRight - TAG_PAD_X,
            y: tagY,
            text: line.label,
            align: 'right',
            baseline: 'middle',
          },
          styles: {
            style: 'fill',
            color: line.color,
            backgroundColor: 'transparent',
            size: TAG_FONT_SIZE,
            weight: TAG_FONT_WEIGHT,
            family: FONT,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            borderSize: 0,
          },
          ignoreEvent: true,
        });
      });
      return figures;
    },
  });
}

/** Reconcile the chart overlay with `lines`. Pass `[]` to clear. */
export function syncKlinePriceLines(chart: Chart, lines: ChartPriceLine[]): void {
  ensureKlinePriceLineOverlay();
  // Deterministic order so point index i ↔ lines[i] in createPointFigures.
  const sorted = [...lines].sort((a, b) => b.price - a.price);
  const existing = chart.getOverlays({ groupId: PRICE_LINE_GROUP });
  if (!sorted.length) {
    for (const o of existing) chart.removeOverlay({ id: o.id });
    return;
  }
  const points = sorted.map((l) => ({ value: l.price }));
  const extendData = sorted.map((l) => ({ ...l }));
  const has = existing.some((o) => o.id === OVERLAY_ID);
  // Drop any stale per-line overlays from the previous renderer.
  for (const o of existing) if (o.id !== OVERLAY_ID) chart.removeOverlay({ id: o.id });
  if (has) {
    chart.overrideOverlay({ id: OVERLAY_ID, points, extendData });
  } else {
    chart.createOverlay({
      name: PRICE_LINE_OVERLAY,
      id: OVERLAY_ID,
      groupId: PRICE_LINE_GROUP,
      paneId: 'candle_pane',
      points,
      extendData,
      lock: true,
      visible: true,
      zLevel: -1,
    });
  }
}
