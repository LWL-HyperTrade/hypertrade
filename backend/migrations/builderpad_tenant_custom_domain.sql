-- Creator-owned hostname for an activated (live=own) app.
-- Preview apps must not get a custom domain. Canonical /t/{slug} stays valid.
-- Service-role only. RLS already enabled on tenants (deny-all).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS custom_domain text,
  ADD COLUMN IF NOT EXISTS custom_domain_txt text,
  ADD COLUMN IF NOT EXISTS custom_domain_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain_lower
  ON public.tenants (lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

COMMENT ON COLUMN public.tenants.custom_domain IS
  'Creator hostname (lowercase). Pending until custom_domain_verified_at is set. Activate-only.';

COMMENT ON COLUMN public.tenants.custom_domain_txt IS
  'TXT token at _builderpad.{host}. Owner-only. Null after disconnect.';

COMMENT ON COLUMN public.tenants.custom_domain_verified_at IS
  'When DNS TXT (+ CNAME) checked out. HTTPS is issued by the Vite Vercel project.';
