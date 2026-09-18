import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTenant } from './api';
import { isTenantSkin, useBrandedHost } from './brandedHost';
import type { TenantPublic } from './tenants';

const PATH_TENANT_RE = /^\/t\/([^/]+)(?:\/|$)/;

/**
 * Slug whose creator chrome should wrap the current page: the branded host, or
 * `/t/{slug}` on localhost / Vercel previews so the creator site can be checked
 * without wildcard DNS. Empty on console pages.
 */
export function useCreatorSlug(): { slug: string; home: string } {
  const branded = useBrandedHost();
  const { pathname } = useLocation();
  if (isTenantSkin(branded)) return { slug: branded.slug, home: '/' };
  const m = PATH_TENANT_RE.exec(pathname);
  if (m && !/^\/t\/[^/]+\/trade\//.test(pathname)) {
    return { slug: decodeURIComponent(m[1]), home: `/t/${m[1]}` };
  }
  return { slug: '', home: '/' };
}

/**
 * Public tenant for the creator host (`{slug}.builderpad.xyz` / custom CNAME).
 * Light, unauthenticated read shared by the header, footer, legal pages and login.
 * `undefined` on the console host.
 */
export function useTenantBrand(): TenantPublic | undefined {
  const { slug } = useCreatorSlug();
  const q = useQuery({
    queryKey: ['tenant-brand', slug],
    enabled: !!slug,
    queryFn: () => fetchTenant(slug, null),
    staleTime: 60_000,
  });
  return slug ? q.data : undefined;
}

/**
 * Favicon only — for pages that own `document.title` themselves (trade terminal
 * shows live price in the tab). Restores the BuilderPad icon on unmount.
 */
export function useCreatorFavicon(tenant: TenantPublic | undefined) {
  const logo = tenant?.logo_url ?? '';
  useEffect(() => {
    if (!logo) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const prevHref = link.href;
    const prevType = link.type;
    link.href = logo;
    link.type = '';
    return () => {
      link.href = prevHref;
      link.type = prevType;
    };
  }, [logo]);
}

/** Swap tab title, favicon, and Open Graph / Twitter image to the creator brand. */
export function useCreatorDocumentBrand(tenant: TenantPublic | undefined, title?: string) {
  useEffect(() => {
    if (!tenant) return;
    const prevTitle = document.title;
    const pageTitle = title ?? tenant.app_name;
    document.title = pageTitle;

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const prevHref = link?.href ?? null;
    const prevType = link?.type ?? '';
    if (link && tenant.logo_url) {
      link.href = tenant.logo_url;
      link.type = '';
    }

    const desc =
      tenant.description.trim() ||
      `${tenant.app_name} — trade on Hyperliquid and earn with this creator.`;
    const rawImage = tenant.logo_url || '/builderpad_og_image.png';
    const image = /^https?:\/\//i.test(rawImage) ? rawImage : absoluteAsset(rawImage);
    const ogKeys = [
      ['og:title', pageTitle],
      ['og:description', desc],
      ['og:image', image],
      ['og:image:secure_url', image],
      ['og:type', 'website'],
      ['og:site_name', 'BuilderPad'],
    ] as const;
    const twitterKeys = [
      ['twitter:card', 'summary_large_image'],
      ['twitter:title', pageTitle],
      ['twitter:description', desc],
      ['twitter:image', image],
    ] as const;
    const created: HTMLMetaElement[] = [];
    const restored: { el: HTMLMetaElement; content: string }[] = [];
    const upsert = (attr: 'property' | 'name', key: string, content: string) => {
      const existing = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (existing) {
        restored.push({ el: existing, content: existing.content });
        existing.content = content;
        return;
      }
      const el = document.createElement('meta');
      el.setAttribute(attr, key);
      el.content = content;
      document.head.appendChild(el);
      created.push(el);
    };
    for (const [property, content] of ogKeys) upsert('property', property, content);
    for (const [name, content] of twitterKeys) upsert('name', name, content);

    return () => {
      document.title = prevTitle;
      if (link && prevHref) {
        link.href = prevHref;
        link.type = prevType;
      }
      for (const { el, content } of restored) el.content = content;
      for (const el of created) el.remove();
    };
  }, [tenant, title]);
}

function absoluteAsset(path: string): string {
  if (typeof window === 'undefined') return path;
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}
