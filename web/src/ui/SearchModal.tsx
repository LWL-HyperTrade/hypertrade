import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listTenantDirectory } from '../lib/api';
import { formatCompactUsd, relativeAgo } from '../lib/earnings';
import { displayVolumeUsd, type TenantPublic } from '../lib/tenants';
import { goToTenantApp } from '../lib/config';
import { IconChevron, IconClose, IconSearch } from './icons';
import { SearchResultsSkeleton } from './skeleton';

const PREVIEW = 24;

function haystack(t: TenantPublic): string {
  return [
    t.app_name,
    t.slug,
    t.description,
    t.coin?.symbol,
    t.coin?.token,
    t.builder_address,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchScore(t: TenantPublic, needle: string): number {
  const q = needle.toLowerCase();
  const slug = t.slug.toLowerCase();
  const name = t.app_name.toLowerCase();
  const sym = (t.coin?.symbol || '').toLowerCase();
  const token = (t.coin?.token || '').toLowerCase();
  if (slug === q || sym === q) return 100;
  if (slug.startsWith(q) || sym.startsWith(q)) return 80;
  if (name.startsWith(q)) return 70;
  if (token === q || (q.startsWith('0x') && token.includes(q))) return 65;
  if (name.includes(q) || slug.includes(q) || sym.includes(q)) return 40;
  if (haystack(t).includes(q)) return 10;
  return 0;
}

function searchTenants(rows: TenantPublic[], query: string): TenantPublic[] {
  const needle = query.trim();
  if (!needle) {
    return [...rows]
      .sort((a, b) => displayVolumeUsd(b) - displayVolumeUsd(a))
      .slice(0, PREVIEW);
  }
  return rows
    .map((t) => ({ t, score: matchScore(t, needle) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || displayVolumeUsd(b.t) - displayVolumeUsd(a.t))
    .map((x) => x.t)
    .slice(0, PREVIEW);
}

function ResultRow({
  t,
  active,
  onPick,
  onHover,
}: {
  t: TenantPublic;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const sym = t.coin?.symbol;
  const vol = displayVolumeUsd(t);
  const age = relativeAgo(t.coin?.launched_at || t.created_at);
  const meta = [
    sym ? `$${sym}` : null,
    vol > 0 ? `${formatCompactUsd(vol)} vol` : null,
    age || null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          active ? 'bg-brand-soft' : 'hover:bg-fill-hover'
        }`}
        onClick={onPick}
        onMouseEnter={onHover}
      >
        {t.logo_url ? (
          <img src={t.logo_url} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fill-weak text-[12px] font-extrabold text-fg-subtle">
            {(t.app_name || t.slug).slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-extrabold text-fg">{t.app_name || t.slug}</span>
          {meta ? <span className="block truncate text-[12px] font-medium text-fg-subtle">{meta}</span> : null}
        </span>
        {active ? <IconChevron size={14} className="-rotate-90 text-fg-subtle" /> : null}
      </button>
    </li>
  );
}

export function SearchModal({
  query,
  onQuery,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const directory = useQuery({
    queryKey: ['tenants', 'directory', 'search'],
    queryFn: () => listTenantDirectory(100),
    staleTime: 30_000,
  });
  const all = directory.data ?? [];
  const rows = useMemo(() => searchTenants(all, query), [all, query]);
  const totalMatch = useMemo(() => {
    const needle = query.trim();
    if (!needle) return all.length;
    return all.filter((t) => matchScore(t, needle) > 0).length;
  }, [all, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const pick = (t: TenantPublic) => {
    onClose();
    goToTenantApp(t.slug, navigate);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      pick(rows[active]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-sunken/70 px-3 pt-[12vh] backdrop-blur-[2px] sm:px-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border-2 border-stroke-strong bg-surface shadow-[6px_6px_0_0_#0a2e1c]"
        role="dialog"
        aria-label="Search apps"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="relative border-b border-stroke-weak">
          <IconSearch
            size={18}
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search name, ticker, or address"
            aria-label="Search name, ticker, or address"
            className="w-full bg-background py-3.5 pl-11 pr-11 text-[14px] font-semibold text-fg outline-none placeholder:font-medium placeholder:text-fg-subtle"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-fg-subtle hover:bg-fill-hover hover:text-fg"
              onClick={() => onQuery('')}
            >
              <IconClose size={16} />
            </button>
          ) : null}
        </div>

        <div className="px-4 pb-1 pt-3">
          <span className="inline-flex rounded-full bg-fill-weak px-3 py-1 text-[11px] font-extrabold text-fg">
            {query.trim() ? 'Results' : 'Trending'}
          </span>
        </div>

        <ul role="listbox" className="max-h-[min(420px,50vh)] overflow-y-auto py-1">
          {directory.isLoading && !directory.data ? (
            <SearchResultsSkeleton />
          ) : rows.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-fg-subtle">No apps match that search.</li>
          ) : (
            rows.map((t, i) => (
              <ResultRow
                key={t.id}
                t={t}
                active={i === active}
                onPick={() => pick(t)}
                onHover={() => setActive(i)}
              />
            ))
          )}
        </ul>

        {totalMatch > rows.length ? (
          <div className="border-t border-stroke-weak px-4 py-3 text-[12px] font-medium text-fg-subtle">
            Showing {rows.length} of {totalMatch}
          </div>
        ) : null}
      </div>
    </div>
  );
}
