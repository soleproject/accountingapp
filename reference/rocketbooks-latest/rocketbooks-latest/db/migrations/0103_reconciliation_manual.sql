-- Manual reconciliation overrides. When a user force-reconciles a period (or
-- manually matches/excludes lines), those decisions must survive the engine's
-- idempotent re-runs (statement re-upload, monthly cron). manually_reconciled
-- locks the period's RECONCILED status; user-EXCLUDED statement_lines and
-- user-created reconciliation_matches (created_by = a real user id, not
-- 'engine'/'ai') are preserved by the engine on re-run.
--
-- Idempotent.

ALTER TABLE public.reconciliation_periods
  ADD COLUMN IF NOT EXISTS manually_reconciled boolean NOT NULL DEFAULT false;
