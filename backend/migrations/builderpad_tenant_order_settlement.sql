-- Snapshot the builder address that was on the order, and persist HL
-- userFills settlement: filled notional + builderFee joined on (wallet, oid).

ALTER TABLE public.tenant_order_attributions
  ADD COLUMN IF NOT EXISTS builder_address text,
  ADD COLUMN IF NOT EXISTS filled_notional_usd numeric,
  ADD COLUMN IF NOT EXISTS settled_builder_fee_usd numeric,
  ADD COLUMN IF NOT EXISTS fill_count integer,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

UPDATE public.tenant_order_attributions a
SET builder_address = lower(t.builder_address)
FROM public.tenants t
WHERE a.tenant_id = t.id
  AND a.builder_address IS NULL
  AND t.builder_address IS NOT NULL;

COMMENT ON COLUMN public.tenant_order_attributions.builder_address IS
  'Builder address attached on the order (platform or a future per-tenant builder).';

COMMENT ON COLUMN public.tenant_order_attributions.settled_builder_fee_usd IS
  'Sum of HL userFills.builderFee for this (wallet, oid). Null until settled.';
