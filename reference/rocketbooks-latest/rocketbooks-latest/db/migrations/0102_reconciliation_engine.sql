-- AI reconciliation engine support. The reconciliation_periods / statement_lines
-- / reconciliation_matches tables already exist (from 0000) but had no logic.
-- This adds the columns/constraints the engine needs to run + upsert idempotently.
--
-- Idempotent — safe to re-run.

-- 1. Plain-language AI (or templated) explanation of a period's reconciliation
--    result — shown on the detail page and copied into the needs-attention task.
ALTER TABLE public.reconciliation_periods
  ADD COLUMN IF NOT EXISTS ai_explanation text;

-- 2. One reconciliation period per (org, account, period) so the engine can
--    find-or-create + wipe-and-rewrite idempotently when both the statement
--    upload and the monthly cron fire for the same account+month.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_periods_org_acct_period
  ON public.reconciliation_periods (organization_id, account_id, start_date, end_date);

-- 3. At most one OPEN reconciliation needs-attention task per period — lets the
--    task upsert dedupe via ON CONFLICT and prevents duplicate cards.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_task_open_per_period
  ON public.tasks (entity_id)
  WHERE product = 'reconciliation'
    AND entity_type = 'reconciliation_period'
    AND status = 'OPEN';
