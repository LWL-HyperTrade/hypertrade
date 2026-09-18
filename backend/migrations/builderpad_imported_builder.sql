-- Imported Standard builder: MetaMask / injected EOA as builder_wallet,
-- Privy HD 0 as trade_wallet. source=imported uses builder_wallet_index 0
-- (not an HD path). Embedded creators stay source=embedded, index >= 1.

ALTER TABLE public.tenant_builder_wallets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'embedded';

ALTER TABLE public.tenant_builder_wallets
  DROP CONSTRAINT IF EXISTS tenant_builder_wallets_source_check;

ALTER TABLE public.tenant_builder_wallets
  ADD CONSTRAINT tenant_builder_wallets_source_check
  CHECK (source IN ('embedded', 'imported'));

ALTER TABLE public.tenant_builder_wallets
  DROP CONSTRAINT IF EXISTS tenant_builder_wallets_builder_wallet_index_check;

ALTER TABLE public.tenant_builder_wallets
  DROP CONSTRAINT IF EXISTS tenant_builder_wallets_builder_index_ok;

ALTER TABLE public.tenant_builder_wallets
  ADD CONSTRAINT tenant_builder_wallets_builder_index_ok
  CHECK (
    (source = 'embedded' AND builder_wallet_index >= 1)
    OR (source = 'imported' AND builder_wallet_index = 0)
  );

COMMENT ON COLUMN public.tenant_builder_wallets.source IS
  'embedded = Privy HD 1 builder. imported = linked external EVM (MetaMask). Never unify either.';

COMMENT ON TABLE public.tenant_builder_wallets IS
  'Creator pair: HD0 trade (unified) vs builder (Standard). Builder is HD1 or an imported external EOA.';
