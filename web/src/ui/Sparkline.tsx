import { useId } from 'react';

/**
 * Tiny SVG line + soft fill. Normalises to its own min/max so curve trade
 * ratios and Gecko closes render the same. Renders nothing under 2 points.
 */
export function Sparkline({
  points,
  up = true,
  className = '',
  strokeWidth = 2,
}: {
  points: number[];
  up?: boolean;
  className?: string;
  strokeWidth?: number;
}) {
  const id = useId();
  if (!points || points.length < 2) return null;
  const W = 240;
  const H = 72;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || max || 1;
  const step = (W - pad * 2) / (points.length - 1);
  const coords = points.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (H - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${H} L${coords[0][0].toFixed(1)} ${H} Z`;
  const color = up ? 'var(--market-up)' : 'var(--market-down)';
  const [lx, ly] = coords[coords.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-fill)`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r="3" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
