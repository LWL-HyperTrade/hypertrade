import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatZoneClock,
  formatZoneRow,
  zonesForPicker,
} from '../../lib/chartTimezone';
import { IconCheck } from '../icons';

export function ChartTimezone({
  timezone,
  open,
  onToggle,
  onPick,
  hideTrigger = false,
}: {
  timezone: string;
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  hideTrigger?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const el = selectedRef.current;
      const wrap = el?.parentElement;
      if (!el || !wrap) return;
      wrap.scrollTop = Math.max(0, el.offsetTop - wrap.clientHeight / 2 + el.clientHeight / 2);
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, timezone]);

  const zones = useMemo(() => zonesForPicker(timezone), [timezone]);

  return (
    <div className={`relative shrink-0 ${hideTrigger ? 'contents' : ''}`}>
      {hideTrigger ? null : (
        <button
          type="button"
          title="Chart timezone"
          aria-expanded={open}
          onClick={onToggle}
          className={`shrink-0 whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[11px] tabular-nums ${
            open ? 'bg-brand-soft text-brand' : 'text-fg-subtle hover:bg-fill-hover hover:text-fg'
          }`}
        >
          {formatZoneClock(timezone, now)}
        </button>
      )}
      {open ? (
        <div
          className={
            hideTrigger
              ? 'w-[15.5rem] overflow-hidden rounded-md border border-stroke-weak bg-background shadow-lg'
              : 'absolute right-0 top-full z-30 mt-1 w-[15.5rem] overflow-hidden rounded-md border border-stroke-weak bg-background shadow-lg'
          }
        >
          <div className="max-h-64 overflow-y-auto py-1">
            {zones.map((z) => {
              const on = z.id === timezone;
              return (
                <button
                  key={z.id}
                  ref={on ? selectedRef : undefined}
                  type="button"
                  onClick={() => onPick(z.id)}
                  className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] ${
                    on ? 'text-fg' : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                  }`}
                >
                  <span className="inline-flex w-3.5 shrink-0 justify-center text-brand">
                    {on ? <IconCheck size={11} /> : null}
                  </span>
                  {formatZoneRow(z, now)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
