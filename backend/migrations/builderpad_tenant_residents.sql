-- BuilderPad Residents — AI agents that live on a tenant app.
-- Spec: docs/RESIDENTS.md. Optional (BuilderPad + AI Tier 2). Service-role only.
--
-- Apply after: ai_agents_v1.sql (+ follow-ups), builderpad_tenants_v1.sql,
-- builderpad_builder_wallets.sql.

-- ---------------------------------------------------------------------------
-- ai_agents.mode: allow 'resident' — trades from the creator's HD 2 embedded
-- EOA (public, nothing manual on it). Worker treats it like copilot without
-- the manual-conflict guard. Own product-slot pool (ai_agents.py).
-- ---------------------------------------------------------------------------
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_mode_check;
ALTER TABLE public.ai_agents
  ADD CONSTRAINT ai_agents_mode_check
  CHECK (mode IN ('copilot', 'dedicated', 'resident'));

COMMENT ON COLUMN public.ai_agents.mode IS
  'copilot = user main balance (Shared); dedicated = HL sub-account; resident = BuilderPad resident EOA (HD 2), see docs/RESIDENTS.md.';

-- ---------------------------------------------------------------------------
-- tenants: character (persona) + avatar. Editable after publish (like logo).
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS persona jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS avatar jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.tenants.persona IS
  '{ display_name, tone: string[], catchphrases: string[], show_hour_utc: int, bio_voice } — voice only; never trade instructions.';
COMMENT ON COLUMN public.tenants.avatar IS
  '{ kind: preset|vrm, preset_id?, vrm_url?, poster_url } — rendered by web/src/ui/resident/VrmStage.tsx.';

-- ---------------------------------------------------------------------------
-- tenant_residents — which agents live on which app (many agents → one app).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_residents (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id),
  CONSTRAINT tenant_residents_agent_unique UNIQUE (agent_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_residents_tenant
  ON public.tenant_residents (tenant_id, created_at);

COMMENT ON TABLE public.tenant_residents IS
  'Resident agents attached to a BuilderPad app. Worker puts tenants.builder_address / builder_fee_tenths on their orders and writes tenant_order_attributions.';

ALTER TABLE public.tenant_residents ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- tenant_builder_wallets: third embedded EOA — the resident trading wallet.
-- HD 0 trade · HD 1 builder · HD 2 resident. All distinct.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_builder_wallets
  ADD COLUMN IF NOT EXISTS resident_wallet text,
  ADD COLUMN IF NOT EXISTS resident_wallet_index integer;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_builder_wallets_resident_unique
  ON public.tenant_builder_wallets (lower(resident_wallet))
  WHERE resident_wallet IS NOT NULL;

COMMENT ON COLUMN public.tenant_builder_wallets.resident_wallet IS
  'Privy embedded EOA (HD 2) that resident agents trade from. Public address. Never the trade or builder wallet.';

-- ---------------------------------------------------------------------------
-- ai_agent_voice — commentary lines (Phase 1). Display only; never fed back.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_agent_voice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.ai_agents (id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants (id) ON DELETE SET NULL,
  run_id uuid,
  channel text NOT NULL
    CHECK (channel IN ('trade', 'craft', 'macro', 'vibe', 'fun', 'letter', 'cast')),
  mood text NOT NULL DEFAULT 'idle'
    CHECK (mood IN ('idle', 'focused', 'tense', 'smug', 'shrug', 'sleep')),
  text text NOT NULL,
  -- What the line was about: decision ids, symbol, narrative ids. Never prompts.
  refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_voice_tenant_created
  ON public.ai_agent_voice (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_agent_voice_agent_created
  ON public.ai_agent_voice (agent_id, created_at DESC);

ALTER TABLE public.ai_agent_voice ENABLE ROW LEVEL SECURITY;
