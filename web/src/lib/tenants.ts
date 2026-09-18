export const RESERVED_SLUGS = new Set([
  'about', 'admin', 'ai-agents', 'ai-agents-faq', 'api', 'app', 'apps', 'asset', 'assets',
  'bank', 'bank-faq', 'bank-guest', 'bank-notifications', 'bank-statement', 'blog',
  'builderpad', 'cdn', 'create', 'deposit', 'deposit-withdraw-history', 'docs',
  'faq', 'fees', 'ftp', 'health', 'help', 'home', 'hypertrade', 'index', 'legal',
  'login', 'mail', 'me', 'news', 'portfolio', 'price-alerts', 'privacy', 'privacy-policy',
  'profile', 'rewards', 'showcase', 'static', 'status', 'support', 't', 'terms',
  'trade', 'trade-history', 'www',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export function normalizeTenantSlug(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

export function slugError(raw: string): string | null {
  const slug = normalizeTenantSlug(raw);
  if (slug.length < 3 || slug.length > 32) return 'Use 3–32 characters';
  if (!SLUG_RE.test(slug)) return 'Lowercase letters, numbers, and hyphens only';
  if (RESERVED_SLUGS.has(slug)) return 'This slug is reserved';
  return null;
}

/** Hostname labels only — blocks javascript:, data:, IPs, credential tricks. */
const WEBSITE_HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Optional creator website: https + real domain only. Empty is fine.
 * Bare domains get `https://` prepended.
 */
export function normalizeWebsiteUrl(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '';
  if (text.length > 200) throw new Error('Website URL is too long');
  const lower = text.toLowerCase();
  if (lower.startsWith('http://')) throw new Error('Website must use https://');
  const candidate = lower.startsWith('https://') ? text : `https://${text.replace(/^\/+/, '')}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Website must be a domain like example.com');
  }
  if (parsed.protocol !== 'https:') throw new Error('Website must use https://');
  if (parsed.username || parsed.password) throw new Error('Website URL is invalid');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !WEBSITE_HOST_RE.test(host)) {
    throw new Error('Website must be a domain like example.com');
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error('Website must be a domain like example.com');
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  const query = parsed.search || '';
  const out = `https://${host}${path}${query}`;
  if (out.length > 200) throw new Error('Website URL is too long');
  return out;
}

export function websiteError(raw: string): string | null {
  try {
    normalizeWebsiteUrl(raw);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid website';
  }
}

export function feeTenthsToPercentLabel(tenths: number): string {
  const pct = tenths * 0.001;
  return `${pct.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export type TenantSocials = {
  twitter: string;
  telegram: string;
  discord: string;
  tiktok: string;
  instagram: string;
  youtube: string;
  twitch: string;
  website: string;
};

export type TenantAttributionSummary = {
  orders: number;
  est_builder_fee_usd: number;
  settled_builder_fee_usd: number;
  filled_notional_usd: number;
};

/** Lifetime builder fees from HL `referral.builderRewards` (all interfaces). */
export type TenantHlBuilder = {
  fee_usd: number;
  filled_notional_usd: number;
  orders: number;
  source: string;
  notional_from: string;
};

/** Pons v2 launch attached to the app (verified server-side against the factory). */
export type TenantCoin = {
  token: string;
  curve: string;
  /** 0x000…000 = native ETH. */
  pair_token: string;
  chain_id: number;
  launch_config_id: number;
  tx_hash: string;
  symbol: string;
  dev_buy_quote: string;
  creator_tax_bps: number;
  buyback_enabled: boolean;
  fee_recipient: string;
  launched_at?: string | null;
  /** `pons` (default) or `external` — Robinhood token not launched via Pons (showcase). */
  source?: 'pons' | 'external';
  /** External only: venue label + where to trade. */
  venue?: string;
  trade_url?: string;
  pool?: string;
  /** External showcase only — fake card metrics when there is no Pons curve. */
  trade_fee_bps?: number | null;
  earned_usd?: number | null;
  holders?: number | null;
};

export function isExternalCoin(coin?: TenantCoin | null): boolean {
  return coin?.source === 'external';
}

export type WizardDraft = {
  chapter?: number;
  notional?: number;
  show?: Partial<Record<string, boolean>>;
  coin?: {
    symbol?: string;
    pairToken?: string;
    devBuy?: string;
    creatorTaxBps?: number;
    buybackEnabled?: boolean;
    creatorFeeRecipient?: string;
    advancedOpen?: boolean;
  };
};

export type BuilderFeeChange = {
  from_tenths: number;
  to_tenths: number;
  changed_at?: string | null;
};

export type PledgeChange = {
  from_pct: number;
  to_pct: number;
  changed_at?: string | null;
};

export type TenantPublic = {
  id: string;
  slug: string;
  app_name: string;
  description: string;
  logo_url: string;
  socials: TenantSocials;
  catalog: string[];
  builder_address: string;
  builder_fee_tenths: number;
  cloid_prefix: string;
  status: 'draft' | 'live' | 'archived';
  url: string;
  created_at?: string;
  owner_wallet?: string | null;
  privy_user_id?: string;
  wizard_draft?: WizardDraft | null;
  attribution?: TenantAttributionSummary;
  hl_builder?: TenantHlBuilder | null;
  coin?: TenantCoin | null;
  builder_fee_history?: BuilderFeeChange[];
  buyback_pct?: number;
  burn_pct?: number;
  buyback_history?: PledgeChange[];
  burn_history?: PledgeChange[];
  custom_domain?: string | null;
  custom_url?: string | null;
  domain?: TenantDomain | null;
  stream?: { twitch: boolean };
  /** Login-level identity across all this creator's live apps. `null` = no verified social → stays anonymous. */
  creator?: TenantCreator | null;
};

export type TenantCreatorApp = {
  slug: string;
  app_name: string;
  logo_url: string;
  coin_symbol?: string | null;
  url: string;
};

export type TenantCreator = {
  /** Opaque stable key (hash of the login), safe to put in URLs. */
  key: string;
  /** Verified handle, lowercase, no `@`. */
  handle: string;
  kind: 'twitter' | 'telegram' | 'twitch' | 'youtube' | 'tiktok' | 'instagram' | 'discord';
  /** Every live app on this login, oldest first (includes the current one). */
  apps: TenantCreatorApp[];
};

/** `@handle` for X-like networks, plain for the rest. */
export function creatorLabel(c: TenantCreator | null | undefined): string {
  if (!c?.handle) return '';
  return c.kind === 'twitter' || c.kind === 'telegram' || c.kind === 'instagram' || c.kind === 'tiktok'
    ? `@${c.handle}`
    : c.handle;
}

/** Other live apps by the same creator (excluding `slug`). */
export function creatorOtherApps(c: TenantCreator | null | undefined, slug: string): TenantCreatorApp[] {
  if (!c) return [];
  return c.apps.filter((a) => a.slug !== slug);
}

/** Owner-only DNS setup. Public responses omit txt_value. */
export type TenantDomain = {
  host: string;
  verified: boolean;
  txt_name: string;
  txt_short: string;
  txt_value: string;
  cname_name: string;
  cname_short: string;
  cname_target: string;
};

/** One entry of GET /api/tenants/pons/quotes. */
export type PonsQuote = {
  pair_token: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_url: string;
  native: boolean;
  graduation_threshold?: string;
};

/** Public volume: desk fills, or lifetime HL builder flow when that is larger. */
export function displayVolumeUsd(t: TenantPublic): number {
  const desk = Number(t.attribution?.filled_notional_usd ?? 0) || 0;
  const hl = Number(t.hl_builder?.filled_notional_usd ?? 0) || 0;
  return Math.max(desk, hl);
}

export function displayOrders(t: TenantPublic): number {
  const desk = Number(t.attribution?.orders ?? 0) || 0;
  const hl = Number(t.hl_builder?.orders ?? 0) || 0;
  return Math.max(desk, hl);
}

export function displayEarnedUsd(t: TenantPublic): number {
  const desk = Number(t.attribution?.settled_builder_fee_usd ?? 0) || 0;
  const hl = Number(t.hl_builder?.fee_usd ?? 0) || 0;
  return Math.max(desk, hl);
}

export function displayEstEarnedUsd(t: TenantPublic): number {
  const desk = Number(t.attribution?.est_builder_fee_usd ?? 0) || 0;
  const hl = Number(t.hl_builder?.fee_usd ?? 0) || 0;
  return Math.max(desk, hl);
}

export type CreateTenantBody = {
  app_name: string;
  slug: string;
  description?: string;
  logo_url?: string;
  socials?: Partial<TenantSocials>;
  catalog: string[];
  builder_fee_tenths: number;
  buyback_pct?: number;
  burn_pct?: number;
  owner_wallet?: string | null;
  status?: 'draft' | 'live';
  wizard_draft?: WizardDraft | null;
};

/** PATCH may archive a live app. Do not reuse CreateTenantBody.status. */
export type PatchTenantBody = Omit<Partial<CreateTenantBody>, 'status'> & {
  status?: TenantPublic['status'];
  slug?: string;
  stream?: { twitch: boolean };
};

export type BuilderWallets = {
  trade_wallet: string;
  builder_wallet: string;
  builder_wallet_index: number;
  source?: 'embedded' | 'imported';
  status: 'provisioned' | 'funded' | 'active';
  live: 'own' | 'preview';
  never_unify_builder: boolean;
  activation_usdc: number;
  activation_fee_usdc?: number;
  activation_fee_paid?: boolean;
  activation_fee_paid_at?: string | null;
  activation_fee_tx?: string | null;
  platform_builder?: string;
  funded_at?: string | null;
  created_at?: string;
  updated_at?: string;
  hl?: {
    perp_equity_usd: number;
    abstraction_mode: string | null;
    standard: boolean;
    ready: boolean;
  };
};

export type AssetRow = {
  coin: string;
  name: string;
  symbol: string;
  category: string;
  isSpotOnly?: boolean;
  isHip3?: boolean;
  growthMode?: boolean | string | null;
  deployerFeeScale?: number | string | null;
  markPx?: string | null;
  change24h?: number | null;
  dayNtlVlm?: string | number | null;
  maxLeverage?: number | null;
};

function catalogKeys(coin: string): string[] {
  const raw = String(coin ?? '').trim();
  if (!raw) return [];
  const keys = [raw, raw.toUpperCase()];
  if (raw.includes(':')) {
    const base = raw.split(':').pop() || '';
    keys.push(base, base.toUpperCase());
  }
  return keys;
}

export function filterAssetsForTenant(assets: AssetRow[], catalog: string[]): AssetRow[] {
  if (!catalog.length) return [];
  const allowed = new Set(catalog.flatMap(catalogKeys));
  return assets.filter((a) => {
    const candidates = [a.coin, a.symbol, a.coin?.split(':').pop()].filter(Boolean) as string[];
    return candidates.some((c) => allowed.has(c) || allowed.has(c.toUpperCase()));
  });
}

/** Perp HYPE when listed; otherwise the first catalog market. */
export function pickDefaultMarket(markets: AssetRow[]): AssetRow | null {
  if (!markets.length) return null;
  const hypePerp = markets.find((m) => m.coin.toUpperCase() === 'HYPE' && !m.isSpotOnly);
  if (hypePerp) return hypePerp;
  return markets.find((m) => m.coin.toUpperCase() === 'HYPE') ?? markets[0];
}
