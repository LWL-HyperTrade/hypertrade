export const TENANT_MAX_FEE_TENTHS = 100;
export const TENANT_DEFAULT_FEE_TENTHS = 30;
export const TENANT_MAX_CATALOG = 80;

export type TenantSocials = {
  twitter: string;
  telegram: string;
  discord: string;
  tiktok?: string;
  instagram?: string;
  youtube?: string;
  twitch?: string;
  website: string;
};

export type TenantAttributionSummary = {
  orders: number;
  est_builder_fee_usd: number;
  settled_builder_fee_usd: number;
  filled_notional_usd: number;
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
  buyback_pct?: number;
  burn_pct?: number;
  cloid_prefix: string;
  status: 'draft' | 'live' | 'archived';
  url: string;
  created_at?: string;
  updated_at?: string;
  privy_user_id?: string;
  owner_wallet?: string | null;
  attribution?: TenantAttributionSummary;
  hl_builder?: {
    fee_usd: number;
    filled_notional_usd: number;
    orders: number;
    source: string;
    notional_from: string;
  } | null;
};

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
