-- Burn is a percent of the buyback, not of the builder fee.
-- 70% buyback + 50% burn = burn half of that buyback. Both 0–100 independently.

ALTER TABLE public.tenants DROP CONSTRAINT IF EXISTS tenants_pledge_sum_ck;

COMMENT ON COLUMN public.tenants.buyback_pct IS
  'Percent of builder-fee take pledged to buy back. Not on-chain.';
COMMENT ON COLUMN public.tenants.burn_pct IS
  'Percent of that buyback pledged to burn (not of the fee). Not on-chain.';
