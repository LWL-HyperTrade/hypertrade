import { useEffect, useRef, useState } from 'react';

/** Tween a number toward `value` with rAF. Ease-out so the last digits settle. */
export function useRollingNumber(value: number, ms = 520): number {
  const [shown, setShown] = useState(value);
  const cur = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const a = cur.current;
    const b = value;
    if (a === b) return;
    const start = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = a + (b - a) * e;
      setShown(cur.current);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, ms]);

  return shown;
}

/** Rolling USD with a tiny bump each time the target changes. */
export function RollingUsd({
  value,
  format,
  className,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  const n = useRollingNumber(value);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    setBump((b) => b + 1);
  }, [value]);
  return (
    <span key={bump} className={`roll roll-bump ${className ?? ''}`}>
      {format(n)}
    </span>
  );
}
