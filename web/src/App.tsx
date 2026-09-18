import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { WebAuthRoot } from './lib/auth';
import { BrandedHostProvider, useBrandedHost } from './lib/brandedHost';
import { tenantPublicUrl, usesPathTenants } from './lib/config';
import { Shell } from './ui/Shell';
import { HomePage } from './ui/HomePage';
import { ExplorePage } from './ui/ExplorePage';
import { AppsPage } from './ui/AppsPage';
import { CreatePage } from './ui/CreatePage';
import { TenantPage } from './ui/TenantPage';
import { TradePage } from './ui/TradePage';
import { LoginPage } from './ui/LoginPage';
import { DocsPage } from './ui/DocsPage';
import { PrivacyPage, TermsPage } from './ui/LegalPages';
import { HlAutoSetup } from './lib/useHlAutoSetup';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <WebAuthRoot>
      <QueryClientProvider client={queryClient}>
        <HlAutoSetup />
        <BrowserRouter>
          <BrandedHostProvider>
            <AppRoutes />
          </BrandedHostProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </WebAuthRoot>
  );
}

function AppRoutes() {
  const branded = useBrandedHost();
  if (branded.kind === 'unknown') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-sunken px-6 text-center">
        <h1 className="display text-3xl">This address is not connected yet</h1>
        <p className="mt-2 max-w-sm text-sm text-fg-muted">
          If you just added DNS records, wait a few minutes and refresh.
        </p>
      </div>
    );
  }
  if (branded.kind === 'pad' || branded.kind === 'custom' || branded.kind === 'loading') {
    // Creator site: one landing page + desk + legal. Console pages live on the apex.
    // `loading` is custom-domain DNS lookup — paint creator chrome + skeletons, not a blank "Loading…".
    return (
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<TenantPage />} />
          <Route path="trade/:coin" element={<TradePage />} />
          <Route path="t/:slug" element={<BrandedSlugRedirect />} />
          <Route path="t/:slug/trade/:coin" element={<BrandedTradeRedirect />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="explore" element={<ExplorePage />} />
        <Route path="apps" element={<AppsPage />} />
        <Route path="create" element={<CreatePage />} />
        <Route path="t/:slug" element={<PathTenantOrRedirect />} />
        <Route path="t/:slug/trade/:coin" element={<PathTradeOrRedirect />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function PathTenantOrRedirect() {
  const { slug = '' } = useParams();
  const path = usesPathTenants();
  useEffect(() => {
    if (!path && slug) window.location.replace(tenantPublicUrl(slug));
  }, [path, slug]);
  if (path) return <TenantPage />;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-sunken text-sm text-fg-muted">
      Opening app…
    </div>
  );
}

function PathTradeOrRedirect() {
  const { slug = '', coin = '' } = useParams();
  const path = usesPathTenants();
  useEffect(() => {
    if (!path && slug) {
      const dest = `${tenantPublicUrl(slug)}/trade/${encodeURIComponent(coin)}`;
      window.location.replace(dest);
    }
  }, [path, slug, coin]);
  if (path) return <TradePage />;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-sunken text-sm text-fg-muted">
      Opening app…
    </div>
  );
}

function BrandedSlugRedirect() {
  return <Navigate to="/" replace />;
}

function BrandedTradeRedirect() {
  const { coin = '' } = useParams();
  return <Navigate to={`/trade/${encodeURIComponent(coin)}`} replace />;
}
