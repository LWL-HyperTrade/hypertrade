import { useEffect, useState, type FormEvent } from 'react';
import { Outlet, useLocation, Link } from 'react-router-dom';
import { loginHref, useWebAuth } from '../lib/auth';
import { isCreatorHost, useBrandedHost } from '../lib/brandedHost';
import { BrandMark } from './BrandMark';
import { CreatorShell } from './CreatorShell';
import { LwlByline } from './LwlByline';
import { SearchModal } from './SearchModal';
import { SiteFooter } from './SiteFooter';
import { TopCreators } from './TopCreators';
import { WalletSheet } from './WalletSheet';
import { IconClose, IconMenu, IconSearch } from './icons';

export function Shell() {
  const branded = useBrandedHost();
  const { pathname } = useLocation();
  const skin = isCreatorHost(branded);
  const tradeDesk = /^\/t\/[^/]+\/trade\//.test(pathname) || (skin && /^\/trade\//.test(pathname));
  // Local / preview `/t/{slug}` gets the creator chrome too, so the site can be checked pre-DNS.
  const pathTenant = /^\/t\/[^/]+\/?$/.test(pathname);
  if (tradeDesk) return <Outlet />;
  if (skin || pathTenant) return <CreatorShell />;
  return <ConsoleShell />;
}

function ConsoleShell() {
  const { pathname } = useLocation();
  const { authenticated, logout, hydrating } = useWebAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [wideSearch, setWideSearch] = useState(false);
  const home = pathname === '/';
  const explore = pathname.startsWith('/explore');
  const apps = pathname.startsWith('/apps');
  const create = pathname.startsWith('/create');

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const sync = () => setWideSearch(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openSearch = (e?: FormEvent) => {
    e?.preventDefault();
    setSearchOpen(true);
  };

  return (
    <div className="flex min-h-dvh bg-sunken text-fg">
      <aside className="hidden w-[300px] shrink-0 flex-col border-r border-stroke-weak bg-background lg:flex">
        <SidebarBody home={home} explore={explore} apps={apps} create={create} />
      </aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-sunken/70"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="relative flex h-full w-[min(300px,86vw)] flex-col border-r border-stroke-weak bg-background shadow-[8px_0_24px_#00000040]">
            <SidebarBody
              home={home}
              explore={explore}
              apps={apps}
              create={create}
              onClose={() => setMenuOpen(false)}
              authenticated={authenticated}
              onSignOut={authenticated ? () => void logout() : undefined}
            />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-12 items-center gap-2 overflow-x-clip border-b border-stroke-weak bg-background px-2 sm:h-14 sm:gap-3 sm:px-3 lg:px-8">
          <button
            type="button"
            className="relative z-10 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-fg hover:bg-fill-weaker lg:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu size={20} />
          </button>

          {/* Desktop: same max-w-5xl centering as page content (not the wallet flex gap). */}
          <form
            onSubmit={openSearch}
            className="min-w-0 flex-1 lg:pointer-events-none lg:absolute lg:inset-y-0 lg:left-8 lg:right-8 lg:flex lg:items-center"
          >
            <div className="w-full lg:pointer-events-auto lg:mx-auto lg:max-w-5xl">
              <div className="relative w-[6.5rem] sm:w-full sm:max-w-sm lg:max-w-[20rem]">
                <IconSearch
                  size={15}
                  className="pointer-events-none absolute left-2.5 top-1/2 z-[1] -translate-y-1/2 text-fg-subtle sm:left-3.5"
                />
                <input
                  readOnly
                  value={searchOpen ? '' : search}
                  onFocus={() => setSearchOpen(true)}
                  onClick={() => setSearchOpen(true)}
                  placeholder={wideSearch ? 'Search apps, tickers…' : 'Search'}
                  aria-label="Search apps, tickers, or addresses"
                  className="field !rounded-full !border !py-1.5 !pl-8 !pr-2 cursor-text text-[12px] placeholder:font-medium sm:!border-2 sm:!py-2 sm:!pl-10 sm:!pr-[4.25rem] sm:text-[13px]"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded-md border border-stroke-weak bg-fill-weak px-1.5 py-0.5 text-[10px] font-bold text-fg-subtle sm:inline">
                  {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent)
                    ? '⌘K'
                    : 'Ctrl K'}
                </kbd>
              </div>
            </div>
          </form>

          <div className="relative z-10 ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-sm sm:gap-2 lg:gap-3">
            {authenticated ? (
              <WalletSheet />
            ) : hydrating ? (
              <span className="text-xs text-fg-subtle">…</span>
            ) : (
              <div className="mr-1 flex shrink-0 items-center gap-1.5 sm:mr-3 sm:gap-2 lg:mr-5">
                <Link to={loginHref()} className="btn-ghost btn-sm px-2.5 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs">
                  Log in
                </Link>
                <Link to={loginHref()} className="btn-primary btn-sm px-2.5 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs">
                  Sign up
                </Link>
              </div>
            )}
          </div>
        </header>
        <main className="page-enter flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
        <SiteFooter />
      </div>

      {searchOpen ? (
        <SearchModal
          query={search}
          onQuery={setSearch}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SidebarBody({
  home,
  explore,
  apps,
  create,
  onClose,
  authenticated,
  onSignOut,
}: {
  home: boolean;
  explore: boolean;
  apps: boolean;
  create: boolean;
  onClose?: () => void;
  authenticated?: boolean;
  onSignOut?: () => void;
}) {
  return (
    <>
      <div className="flex h-14 items-center justify-between px-4">
        <BrandMark />
        {onClose ? (
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-fg hover:bg-fill-weaker"
            aria-label="Close menu"
            onClick={onClose}
          >
            <IconClose size={18} />
          </button>
        ) : null}
      </div>

      <nav className="flex flex-col gap-1 px-3 pb-3 pt-1">
        <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.08em] text-fg-subtle">
          Console
        </p>
        <NavLink to="/" active={home} icon="🏠" onClick={onClose}>
          Home
        </NavLink>
        <NavLink to="/explore" active={explore} icon="🧭" onClick={onClose}>
          Explore
        </NavLink>
        <NavLink to="/apps" active={apps} icon="📱" onClick={onClose}>
          My Projects
        </NavLink>
        <NavLink to="/create" active={create} icon="🚀" onClick={onClose}>
          Launch
        </NavLink>
      </nav>

      <div className="flex justify-center px-6" aria-hidden>
        <div className="h-px w-[70%] max-w-[10rem] bg-stroke-weak" />
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-6">
        <TopCreators />
      </div>

      <div className="flex items-center border-t border-stroke-weak px-3 py-3 lg:h-[69px] lg:py-0">
        <div className="w-full">
          <LwlByline />
          {authenticated && onSignOut ? (
            <button
              type="button"
              className="btn-ghost btn-sm mt-3 w-full py-2 text-xs"
              onClick={onSignOut}
            >
              Sign out
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function NavLink({
  to,
  active,
  icon,
  children,
  onClick,
}: {
  to: string;
  active: boolean;
  icon: string;
  children: string;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-colors ${
        active ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:bg-fill-weaker hover:text-fg'
      }`}
    >
      <span className="w-5 shrink-0 text-center text-[15px] leading-none" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">{children}</span>
    </Link>
  );
}
