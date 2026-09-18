-- Additive if builderpad_tenant_order_est_fee.sql already ran without this column.

ALTER TABLE public.tenant_order_attributions
  ADD COLUMN IF NOT EXISTS reduce_only boolean;

COMMENT ON COLUMN public.tenant_order_attributions.reduce_only IS
  'True when the client placed a reduce-only close/reduce.';
