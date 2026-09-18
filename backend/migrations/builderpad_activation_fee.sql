-- One-time $5 (configurable) BuilderPad activation fee, paid from the
-- builder wallet on Arbitrum via gasless USDC permit. Separate from the
-- 100 USDC Hyperliquid parks in the same wallet (that pile stays theirs).

ALTER TABLE public.tenant_builder_wallets
  ADD COLUMN IF NOT EXISTS activation_fee_tx text,
  ADD COLUMN IF NOT EXISTS activation_fee_paid_at timestamptz;

COMMENT ON COLUMN public.tenant_builder_wallets.activation_fee_tx IS
  'Arbitrum USDC transferFrom hash for the BuilderPad activation fee. Null until paid.';
COMMENT ON COLUMN public.tenant_builder_wallets.activation_fee_paid_at IS
  'Set once the fee lands. live=own is refused until this is set. Never charge twice.';
