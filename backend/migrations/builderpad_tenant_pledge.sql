-- App-level pledges: buyback_pct of the builder-fee take, burn_pct of that buyback.
-- Cosmetic + trust: not Pons on-chain buyback, not enforced. Live apps may
-- edit them independently (each 0–100); each change is append-only so traders see the trail.
-- Service-role only. RLS enabled with NO policies (deny-all).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS buyback_pct integer NOT NULL DEFAULT 0
    CHECK (buyback_pct >= 0 AND buyback_pct <= 100);

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS burn_pct integer NOT NULL DEFAULT 0
    CHECK (burn_pct >= 0 AND burn_pct <= 100);

COMMENT ON COLUMN public.tenants.buyback_pct IS
  'Percent of builder-fee take the creator pledges to buy back. Not on-chain.';
COMMENT ON COLUMN public.tenants.burn_pct IS
  'Percent of that buyback the creator pledges to burn (not of the fee). Not on-chain.';

CREATE TABLE IF NOT EXISTS public.tenant_pledge_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('buyback', 'burn')),
  from_pct integer NOT NULL
    CHECK (from_pct >= 0 AND from_pct <= 100),
  to_pct integer NOT NULL
    CHECK (to_pct >= 0 AND to_pct <= 100),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_pct <> to_pct)
);

CREATE INDEX IF NOT EXISTS idx_tenant_pledge_history_tenant
  ON public.tenant_pledge_history (tenant_id, kind, changed_at DESC);

COMMENT ON TABLE public.tenant_pledge_history IS
  'BuilderPad: each live-app buyback/burn pledge change. Public on tenant cards.';

ALTER TABLE public.tenant_pledge_history ENABLE ROW LEVEL SECURITY;
