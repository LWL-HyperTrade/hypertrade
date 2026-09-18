-- Pons v2 coin launched from the BuilderPad wizard (chapter 3).
-- Written only after the backend re-read the factory record
-- (`getLaunchedToken(token).exists` and `deployer == owner_wallet`).
-- Curve / token addresses are per launch — never hardcode them.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS coin_token text,
  ADD COLUMN IF NOT EXISTS coin_curve text,
  ADD COLUMN IF NOT EXISTS coin_pair_token text,
  ADD COLUMN IF NOT EXISTS coin_chain_id integer,
  ADD COLUMN IF NOT EXISTS coin_launch_config_id integer,
  ADD COLUMN IF NOT EXISTS coin_tx_hash text,
  ADD COLUMN IF NOT EXISTS coin_symbol text,
  ADD COLUMN IF NOT EXISTS coin_dev_buy_quote text,
  ADD COLUMN IF NOT EXISTS coin_creator_tax_bps integer,
  ADD COLUMN IF NOT EXISTS coin_buyback_enabled boolean,
  ADD COLUMN IF NOT EXISTS coin_fee_recipient text,
  ADD COLUMN IF NOT EXISTS coin_launched_at timestamptz;

COMMENT ON COLUMN public.tenants.coin_token IS
  'Pons v2 launch token (ERC-20) on Robinhood Chain. Verified against factory getLaunchedToken.';
COMMENT ON COLUMN public.tenants.coin_curve IS
  'Bonding curve for the token, from the same factory record.';
COMMENT ON COLUMN public.tenants.coin_pair_token IS
  'Quote asset. 0x000…000 = native ETH; else an approved ERC-20 (tokenised stock, USDG).';
COMMENT ON COLUMN public.tenants.coin_chain_id IS
  'EVM chain id of the launch (4663 = Robinhood Chain).';
COMMENT ON COLUMN public.tenants.coin_launch_config_id IS
  'Factory launch config id used (append-only list on the factory).';
COMMENT ON COLUMN public.tenants.coin_tx_hash IS
  'launchToken / launchAndBuy transaction hash.';
COMMENT ON COLUMN public.tenants.coin_dev_buy_quote IS
  'Creator opening buy in quote units (human string), 0 when launched without one.';
COMMENT ON COLUMN public.tenants.coin_creator_tax_bps IS
  'Immutable creator tax in bps, read back from the factory record.';
COMMENT ON COLUMN public.tenants.coin_fee_recipient IS
  'creatorFeeRecipient at launch (defaults to HD 0). Escrow balances accrue here.';
