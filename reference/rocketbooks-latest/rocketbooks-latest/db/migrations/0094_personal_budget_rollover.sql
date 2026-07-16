-- Personal budgets: rollover toggle.
--
-- When set, unused budget from prior months accumulates into the current
-- month's available amount. The carry is computed live from transaction
-- history (no monthly snapshot needed), so this is the only column required.
--
-- Additive + idempotent.

ALTER TABLE public.personal_budgets
  ADD COLUMN IF NOT EXISTS rollover boolean NOT NULL DEFAULT false;
