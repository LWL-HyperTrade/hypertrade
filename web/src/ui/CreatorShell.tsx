import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchCatalogAssets } from '../lib/api';
import { loginHref, useWebAuth } from '../lib/auth';
import { useTenantPaths } from '../lib/brandedHost';
import { filterAssetsForTenant, pickDefaultMarket, type TenantPublic } from '../lib/tenants';
import { useCreatorDocumentBrand, useCreatorSlug, useTenantBrand } from '../lib/useTenantBrand';
import { WalletSheet } from './WalletSheet';
import { BrandStatus } from './BrandMark';
import { IconClose, IconExternal, IconMenu } from './icons';

const YEAR = new Date().getFullYear();

type Anchor = { id: 'home' | 'app' | 'token'; label: string };

/**
 * Creator-branded chrome for `{slug}.builderpad.xyz` and custom CNAMEs.
 * One-page landing: Home · App · Token scroll to sections. Login stays top-right.
 * No BuilderPad sidebar, search, or byline — this is the creator's site.
 */
export function CreatorShell() {
  const tenant = useTenantBrand();
  useCreatorDocumentBrand(tenant);
  return (
    <div className="flex min-h-dvh flex-col bg-sunken text-fg">
      <CreatorHeader tenant={tenant} />
      <main className="page-enter flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
      <CreatorFooter tenant={tenant} />
    </div>
  );
}

function useLaunchAppHref(tenant: TenantPublic | undefined): string | null {
  const paths = useTenantPaths();
  const catalogQ = useQuery({
    queryKey: ['catalog'],
    queryFn: fetchCatalogAssets,
    staleTime: 60_000,
    enabled: !!tenant,
  });
  if (!tenant || !catalogQ.data) return null;
  const first = pickDefaultMarket(filterAssetsForTenant(catalogQ.data, tenant.catalog));
  return first ? paths.trade(tenant.slug, first.coin) : null;
}

function useAnchors(): Anchor[] {
  return [
    { id: 'home', label: 'Home' },
    { id: 'app', label: 'App' },
    { id: 'token', label: 'Token' },
  ];
}

function CreatorHeader({ tenant }: { tenant: TenantPublic | undefined }) {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const { authenticated, hydrating, logout } = useWebAuth();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const anchors = useAnchors();
  const launchTo = useLaunchAppHref(tenant);
  const { home } = useCreatorSlug();
  const onHome = pathname === home || pathname === `${home}/`;

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname, hash]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (id: Anchor['id']) => {
    setOpen(false);
    if (id === 'home') {
      if (onHome) window.scrollTo({ top: 0, behavior: 'smooth' });
      else navigate(home);
      return;
    }
    if (onHome) {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#${id}`);
    } else {
      navigate(`${home}#${id}`);
    }
  };

  const name = tenant?.app_name ?? '';
  const loadingBrand = !tenant;

  return (
    <header className="sticky top-0 z-30 border-b border-stroke-weak bg-sunken/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:h-16 sm:gap-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={() => go('home')}
          className="flex min-w-0 shrink-0 items-center gap-2.5 text-left"
          aria-label={name ? `${name} home` : 'Home'}
        >
          {loadingBrand ? (
            <span className="skel h-8 w-8 shrink-0 rounded-[8px] sm:h-9 sm:w-9" aria-hidden />
          ) : tenant.logo_url ? (
            <img src={tenant.logo_url} alt="" className="h-8 w-8 shrink-0 rounded-[8px] object-cover sm:h-9 sm:w-9" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-brand text-[13px] font-black text-black sm:h-9 sm:w-9">
              {(name || 'A').slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="flex min-w-0 flex-col items-start justify-center gap-0.5">
            <span className="max-w-[9rem] truncate text-[15px] font-extrabold leading-none tracking-tight sm:max-w-[14rem] sm:text-[16px]">
              {name || <span className="skel inline-block h-4 w-24 align-middle" />}
            </span>
            {name ? <BrandStatus /> : null}
          </span>
        </button>

        <nav className="ml-2 hidden items-center gap-0.5 md:flex" aria-label="Sections">
          {anchors.map((a) => (
            <button key={a.id} type="button" className="creator-nav-link" onClick={() => go(a.id)}>
              {a.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          {launchTo && !mobile ? (
            <Link to={launchTo} className="btn-primary btn-sm px-3 py-1.5 text-xs">
              Launch App <IconExternal size={13} />
            </Link>
          ) : null}
          {authenticated ? (
            <WalletSheet compact hideProfile />
          ) : hydrating ? (
            <span className="text-xs text-fg-subtle">…</span>
          ) : (
            <div className="flex shrink-0 items-center gap-1.5">
              <Link to={loginHref()} className="btn-ghost btn-sm px-2.5 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs">
                Log in
              </Link>
              <Link
                to={loginHref()}
                className="btn-primary btn-sm hidden px-2.5 py-1 text-[11px] sm:inline-flex sm:px-3 sm:py-1.5 sm:text-xs"
              >
                Sign up
              </Link>
            </div>
          )}
          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-fg hover:bg-fill-weaker md:hidden"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <IconMenu size={20} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-sunken/75"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-x-3 top-3 rounded-2xl border border-stroke-weak bg-background p-3 shadow-[6px_6px_0_0_#0a2e1c]">
            <div className="flex items-center justify-between px-1">
              <span className="text-[13px] font-extrabold">{name}</span>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-fg hover:bg-fill-weaker"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
              >
                <IconClose size={18} />
              </button>
            </div>
            <nav className="mt-1 flex flex-col">
              {anchors.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="rounded-xl px-3 py-2.5 text-left text-[14px] font-bold text-fg-muted hover:bg-fill-weaker hover:text-fg"
                  onClick={() => go(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </nav>
            <div className="mt-2 flex flex-col gap-2 border-t border-stroke-weak pt-3">
              {launchTo ? (
                <Link to={launchTo} className="btn-primary w-full py-2.5 text-sm">
                  Launch App <IconExternal size={14} />
                </Link>
              ) : null}
              {authenticated ? (
                <button type="button" className="btn-ghost w-full py-2.5 text-sm" onClick={() => void logout()}>
                  Sign out
                </button>
              ) : (
                <Link to={loginHref()} className="btn-ghost w-full py-2.5 text-sm">
                  Log in
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function CreatorFooter({ tenant }: { tenant: TenantPublic | undefined }) {
  const name = tenant?.app_name ?? '';
  const { home } = useCreatorSlug();
  return (
    <footer className="mt-auto border-t border-stroke-weak bg-background px-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 py-4 text-[11px] font-semibold leading-relaxed text-fg-subtle lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <p className="min-w-0">
          © {YEAR} {name}
          <span className="mx-2 hidden text-stroke-strong sm:inline" aria-hidden>
            ·
          </span>
          <span className="block sm:inline">Trading involves risk. Not available in restricted jurisdictions.</span>
        </p>
        <nav className="flex shrink-0 items-center gap-x-4 text-[12px] font-bold text-fg-muted">
          <Link to={home} className="hover:text-fg">
            Home
          </Link>
          <Link to="/docs" className="hover:text-fg">
            Docs
          </Link>
          <Link to="/terms" className="hover:text-fg">
            Terms
          </Link>
          <Link to="/privacy" className="hover:text-fg">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
