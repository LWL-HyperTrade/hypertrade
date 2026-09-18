-- One Privy user → two embedded EOAs.
-- trade_wallet (HD 0): unified desk / deposits / orders.
-- builder_wallet (HD 1): stays Standard. Never run userSetAbstraction on it.
-- tenants.builder_address stays the platform builder until this wallet is
-- funded (100 USDC perp) and activated in a later step.

CREATE TABLE IF NOT EXISTS public.tenant_builder_wallets (
  privy_user_id text PRIMARY KEY,
  trade_wallet text NOT NULL,
  builder_wallet text NOT NULL,
  builder_wallet_index integer NOT NULL DEFAULT 1
    CHECK (builder_wallet_index >= 1),
  status text NOT NULL DEFAULT 'provisioned'
    CHECK (status IN ('provisioned', 'funded', 'active')),
  funded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_builder_wallets_distinct CHECK (trade_wallet <> builder_wallet),
  CONSTRAINT tenant_builder_wallets_builder_unique UNIQUE (builder_wallet)
);

CREATE INDEX IF NOT EXISTS idx_tenant_builder_wallets_trade
  ON public.tenant_builder_wallets (trade_wallet);

COMMENT ON TABLE public.tenant_builder_wallets IS
  'Creator Privy pair: HD0 trade (unified) vs HD1 builder (Standard, never unify).';

COMMENT ON COLUMN public.tenant_builder_wallets.builder_wallet IS
  'Privy embedded EOA reserved for HL builder codes. Do not unify this address.';

ALTER TABLE public.tenant_builder_wallets ENABLE ROW LEVEL SECURITY;
