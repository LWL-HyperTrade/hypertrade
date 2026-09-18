-- Snapshot tenant fee + place-time notional so we can estimate builder fee
-- without waiting for HL builder_fills.
-- tenths bps: 50 = 5 bps = 0.05% → est = notional * tenths / 100000

ALTER TABLE public.tenant_order_attributions
  ADD COLUMN IF NOT EXISTS notional_usd numeric,
  ADD COLUMN IF NOT EXISTS builder_fee_tenths integer,
  ADD COLUMN IF NOT EXISTS est_builder_fee_usd numeric,
  ADD COLUMN IF NOT EXISTS side text,
  ADD COLUMN IF NOT EXISTS reduce_only boolean;

COMMENT ON COLUMN public.tenant_order_attributions.notional_usd IS
  'Place-time order value (size * px). Estimate only — fills may be smaller.';

COMMENT ON COLUMN public.tenant_order_attributions.builder_fee_tenths IS
  'Tenant fee snapshot at place time (tenths of a bps).';

COMMENT ON COLUMN public.tenant_order_attributions.est_builder_fee_usd IS
  'notional_usd * builder_fee_tenths / 100000. Not a settlement figure.';
