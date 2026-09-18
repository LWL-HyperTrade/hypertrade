-- Append-only builder fee changes for a live app.
-- Identity (name / logo / bio / socials / catalog) stays frozen after publish.
-- Service-role only. RLS enabled with NO policies (deny-all).

CREATE TABLE IF NOT EXISTS public.tenant_builder_fee_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  from_tenths integer NOT NULL
    CHECK (from_tenths >= 0 AND from_tenths <= 100),
  to_tenths integer NOT NULL
    CHECK (to_tenths >= 0 AND to_tenths <= 100),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_tenths <> to_tenths)
);

CREATE INDEX IF NOT EXISTS idx_tenant_fee_history_tenant
  ON public.tenant_builder_fee_history (tenant_id, changed_at DESC);

COMMENT ON TABLE public.tenant_builder_fee_history IS
  'BuilderPad: each live-app builder fee change. Public on tenant cards so traders see the trail.';

ALTER TABLE public.tenant_builder_fee_history ENABLE ROW LEVEL SECURITY;
