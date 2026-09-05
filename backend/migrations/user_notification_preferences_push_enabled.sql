-- Master push opt-in for a Privy user (Profile Notifications toggle).
-- Default ON so existing users keep receiving alerts. When false, the backend
-- clears push_tokens and skips Expo sends. In-app inbox is unchanged.

ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.user_notification_preferences.push_enabled IS
  'Master Expo push opt-in (Privy user_id). Default true. False = no push; tokens cleared on disable.';
