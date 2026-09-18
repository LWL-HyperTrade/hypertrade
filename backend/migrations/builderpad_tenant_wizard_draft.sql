-- One unpublished wizard per creator. Identity lives on the tenant row
-- (slug reserved). Coin chapter + step live in wizard_draft so a tab close
-- after Activate can resume. Directory and public /t/{slug} stay live-only.
-- tenants.status already allows 'draft' (builderpad_tenants_v1.sql).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS wizard_draft jsonb;

COMMENT ON COLUMN public.tenants.wizard_draft IS
  'Wizard progress for status=draft: chapter, coin terms, social toggles. Cleared on live.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_one_draft_per_user
  ON public.tenants (privy_user_id) WHERE status = 'draft';
