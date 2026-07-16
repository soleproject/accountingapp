-- Conversational tax-intake state. `status` already tracks what the FORMS are doing
-- (collecting/crawling/review/complete); `intake_phase` tracks where the guided CONVERSATION
-- is, so a half-finished interview resumes at the right step.
--
-- Phases: classify → documents → interview → review → run → complete
-- (classify is implicit once the row exists; new rows default to 'documents').
-- Idempotent — safe to re-run.

ALTER TABLE public.tax_returns
  ADD COLUMN IF NOT EXISTS intake_phase varchar NOT NULL DEFAULT 'documents';
