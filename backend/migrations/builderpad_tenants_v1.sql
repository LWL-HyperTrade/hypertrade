-- BuilderPad tenant v1 (optional platform feature — not required for Tier 1 trading)
-- Service-role only. RLS enabled with NO policies (deny-all for anon/authenticated).
--
-- Apply after backend/supabase_schema.sql.
-- See docs/BUILDERPAD.md and docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- tenants — branded trading apps on shared HyperTrade infra
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  app_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  logo_url text NOT NULL DEFAULT '',
  socials jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- HL coin ids as the app uses them (e.g. BTC, xyz:TSLA, io:ANTH)
  catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Shared platform builder — stored for display. Do not treat as a
  -- per-tenant builder code. Creators do not deposit 100 USDC.
  builder_address text NOT NULL,
  -- Tenths of a basis point (0–100). 30 = 3 bps = 0.03%.
  builder_fee_tenths integer NOT NULL DEFAULT 30
    CHECK (builder_fee_tenths >= 0 AND builder_fee_tenths <= 100),
  -- 0x4250 + sha256(id)[0:8] — prefix for client-generated cloids
  cloid_prefix text NOT NULL,
  privy_user_id text NOT NULL,
  owner_wallet text,
  status text NOT NULL DEFAULT 'live'
    CHECK (status IN ('draft', 'live', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_lower
  ON public.tenants (lower(slug));
CREATE INDEX IF NOT EXISTS idx_tenants_owner
  ON public.tenants (privy_user_id);
CREATE INDEX IF NOT EXISTS idx_tenants_live
  ON public.tenants (status) WHERE status = 'live';

COMMENT ON TABLE public.tenants IS
  'BuilderPad v1 branded apps. Shared HyperTrade builder address + Privy. Path /t/{slug} on hypertrade.exchange until a builderpad domain is chosen.';

COMMENT ON COLUMN public.tenants.builder_address IS
  'Platform builder (HyperTrade). Not a per-tenant HL builder code.';

COMMENT ON COLUMN public.tenants.cloid_prefix IS
  'Order cloid prefix 0x4250 + tenant hash. Attribution is (wallet, cloid) or (wallet, oid), never cloid alone.';

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- tenant_order_attributions — orders THIS client placed for a tenant
-- Trust/revenue uses (wallet, cloid) or (wallet, oid) matched to HL fills.
-- Prefix-only scans of builder_fills are a hint, not the source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_order_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  privy_user_id text NOT NULL,
  wallet_address text NOT NULL,
  cloid text NOT NULL,
  oid bigint,
  symbol text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_order_wallet_cloid_unique UNIQUE (wallet_address, cloid)
);

CREATE INDEX IF NOT EXISTS idx_tenant_orders_tenant_created
  ON public.tenant_order_attributions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_orders_wallet
  ON public.tenant_order_attributions (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_orders_oid
  ON public.tenant_order_attributions (wallet_address, oid)
  WHERE oid IS NOT NULL;

COMMENT ON TABLE public.tenant_order_attributions IS
  'Orders placed through a tenant skin. Attribute as (user/wallet, cloid) or (user/wallet, oid). Another wallet may reuse the same cloid hex — never key volume on cloid alone.';

ALTER TABLE public.tenant_order_attributions ENABLE ROW LEVEL SECURITY;
