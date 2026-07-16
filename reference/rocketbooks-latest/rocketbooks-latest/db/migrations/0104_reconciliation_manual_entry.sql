-- Manually-started reconciliations. A user can begin a reconciliation by hand
-- (pick the account, the statement period, and the beginning/ending balances)
-- rather than waiting for a statement upload or the monthly cron. These are
-- "clear the transactions" reconciliations (QuickBooks-style): the period
-- reconciles when beginning + cleared transactions == ending. is_manual marks
-- them so the engine never clobbers a hand-started reconciliation on re-run.
--
-- Idempotent.

ALTER TABLE public.reconciliation_periods
  ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false;
