-- Personal budgets: persisted AI review annotation.
--
-- When a suggested budget is applied after an AI review, the AI's take is
-- stamped onto the budget so the Budget tracker can show it durably. Cleared
-- when the limit is later edited manually (the assessment no longer applies).
--
-- Additive + idempotent.

ALTER TABLE public.personal_budgets
  ADD COLUMN IF NOT EXISTS ai_verdict text,
  ADD COLUMN IF NOT EXISTS ai_probability integer,
  ADD COLUMN IF NOT EXISTS ai_note text,
  ADD COLUMN IF NOT EXISTS ai_reviewed_at timestamptz;
