-- Reverts the per-user tour sandbox plumbing. The cool tour now uses the
-- shared demo Co, LLC org and renders a fake invoice card for the
-- create/post demo steps (no DB writes), so the per-user sandbox pointer
-- is no longer needed.
--
-- Safe to run even if 0033_users_tour_sandbox_org_id was never applied;
-- IF EXISTS guards the column drop.

ALTER TABLE public.users
  DROP COLUMN IF EXISTS tour_sandbox_org_id;
