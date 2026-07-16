-- Per-user dismissal timestamp for the dashboard welcome takeover.
-- NULL = takeover auto-fires on next dashboard visit. Set when the user
-- picks any chip or closes the takeover. The Tour button in the top bar
-- clears this column so the takeover re-fires.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS welcome_dismissed_at timestamptz;
