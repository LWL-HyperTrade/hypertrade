/** OrbCast-style shimmer bones for BuilderPad loading states. */

export function Skel({ className = '' }: { className?: string }) {
  return <div className={`skel ${className}`} />;
}

export function BuilderActivateSkeleton() {
  return (
    <div className="card-pop px-5 py-5" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Skel className="h-5 w-5 rounded-md" />
        <Skel className="h-5 w-48" />
        <Skel className="h-5 w-14 rounded-full" />
      </div>
      <Skel className="mt-3 h-3 w-full max-w-md" />
      <Skel className="mt-2 h-3 w-[60%] max-w-sm" />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-fill-weaker px-3 py-3">
          <Skel className="h-3 w-24" />
          <Skel className="mt-2 h-6 w-28" />
        </div>
        <div className="rounded-xl bg-fill-weaker px-3 py-3">
          <Skel className="h-3 w-24" />
          <Skel className="mt-2 h-6 w-20" />
        </div>
      </div>
      <Skel className="mt-4 h-11 w-full rounded-xl" />
    </div>
  );
}

export function AppsListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="mt-4 grid gap-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card overflow-hidden p-4">
          <div className="flex items-start gap-3">
            <Skel className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <Skel className="h-4 w-40" />
              <Skel className="mt-2 h-3 w-24" />
            </div>
            <Skel className="h-8 w-16 rounded-lg" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Skel className="h-8 w-full" />
            <Skel className="h-8 w-full" />
            <Skel className="h-8 w-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AppsHeroSkeleton() {
  return (
    <section className="mt-8 grid gap-3 sm:grid-cols-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card p-4">
          <Skel className="h-3 w-20" />
          <Skel className="mt-3 h-8 w-28" />
          <Skel className="mt-2 h-3 w-24" />
        </div>
      ))}
    </section>
  );
}

export function CreatorPageSkeleton() {
  return (
    <div className="mx-auto max-w-6xl" aria-busy="true">
      <div className="mx-auto mt-4 max-w-5xl overflow-hidden rounded-3xl border border-stroke-weak bg-surface px-5 py-8 sm:mt-6 sm:px-8 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
          <Skel className="h-24 w-24 shrink-0 rounded-3xl sm:h-28 sm:w-28" />
          <div className="min-w-0 flex-1">
            <Skel className="h-10 w-64" />
            <Skel className="mt-3 h-3.5 w-40" />
            <Skel className="mt-3 h-3.5 w-full max-w-lg" />
          </div>
        </div>
        <div className="mt-5 flex gap-2.5">
          <Skel className="h-11 w-36 rounded-xl" />
          <Skel className="h-11 w-28 rounded-xl" />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-10 py-4 opacity-40">
        <Skel className="h-5 w-24" />
        <Skel className="h-5 w-16" />
        <Skel className="h-5 w-20" />
        <Skel className="hidden h-5 w-28 sm:block" />
      </div>
      <div className="mt-12 flex items-end justify-between">
        <div>
          <Skel className="h-3 w-16" />
          <Skel className="mt-2 h-8 w-52" />
        </div>
        <Skel className="hidden h-3.5 w-64 sm:block" />
      </div>
      <Skel className="mt-4 h-[320px] w-full rounded-3xl lg:h-[400px]" />
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-stroke-weak bg-stroke-weak sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-surface px-4 py-3.5">
            <Skel className="h-3 w-14" />
            <Skel className="mt-2 h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function HomeFeedSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      {Array.from({ length: cards }, (_, i) => (
        <li key={i} className="card h-[196px] overflow-hidden p-4">
          <div className="flex gap-3">
            <Skel className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <Skel className="h-4 w-32" />
              <Skel className="mt-2 h-3 w-20" />
            </div>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-2">
            <Skel className="h-8" />
            <Skel className="h-8" />
            <Skel className="h-8" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SearchResultsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="py-1" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skel className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skel className="h-3.5 w-36" />
            <Skel className="mt-2 h-3 w-48" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CoinFeesSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-stroke-weak px-4 py-2.5" aria-busy="true">
      <div className="min-w-0 flex-1">
        <Skel className="h-3 w-28" />
        <Skel className="mt-2 h-3.5 w-52" />
      </div>
      <Skel className="h-8 w-24 shrink-0 rounded-lg" />
    </div>
  );
}

export function TradeDeskSkeleton() {
  return (
    <div className="flex h-dvh flex-col bg-background" aria-busy="true">
      <div className="flex h-12 items-center gap-3 border-b border-stroke-weak px-3">
        <Skel className="h-6 w-6 rounded-[3px]" />
        <Skel className="h-4 w-28" />
        <Skel className="ml-auto h-8 w-24 rounded-lg" />
      </div>
      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[1fr_280px]">
        <div className="min-h-0 border-b border-stroke-weak p-3 lg:border-b-0 lg:border-r">
          <Skel className="h-8 w-40" />
          <Skel className="mt-3 h-[min(420px,50vh)] w-full rounded-xl" />
        </div>
        <div className="p-3">
          <Skel className="h-8 w-full rounded-lg" />
          <Skel className="mt-3 h-10 w-full rounded-lg" />
          <Skel className="mt-3 h-10 w-full rounded-lg" />
          <Skel className="mt-4 h-12 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function InlineSkel({ className = 'h-4 w-16' }: { className?: string }) {
  return <Skel className={`inline-block align-middle ${className}`} />;
}
