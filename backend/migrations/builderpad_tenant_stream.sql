-- Desk stream overlay. Opt-in after publish; not identity.
-- Handle still comes from verified socials.twitch. Service-role only.
-- RLS already enabled on tenants (deny-all).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS stream_twitch boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.stream_twitch IS
  'Show the creator’s Twitch player on the trade desk. Handle is socials.twitch (Privy-verified). Editable after publish.';
