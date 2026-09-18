import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Horizontal scroller with hidden scrollbar + right-edge fade when more content exists. */
export function ScrollFadeX({
  children,
  className = '',
  fadeFrom = 'var(--bg-base)',
}: {
  children: ReactNode;
  className?: string;
  fadeFrom?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canRight, setCanRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setCanRight(max > 2 && el.scrollLeft < max - 2);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [children]);

  return (
    <div className={`scroll-fade-x relative min-w-0 ${className}`}>
      <div ref={ref} className="no-scrollbar flex min-w-0 items-center overflow-x-auto">
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent transition-opacity ${
          canRight ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ ['--tw-gradient-from' as string]: fadeFrom, backgroundImage: `linear-gradient(to left, ${fadeFrom}, transparent)` }}
      />
    </div>
  );
}
