-- Phase 3 of receipt ↔ transaction matching.
--
-- When the upload pipeline finds a high-confidence (≥0.9), exact-amount
-- match it applies automatically: creates transaction_splits from the
-- receipt's line items, builds a new JE (debits per line, credit to the
-- transaction's bank/CC account), and points both the receipt and the
-- transaction at the new JE.
--
-- Undo needs the pre-state to restore: which JE the transaction was
-- pointing at, what category it had, whether the receipt was already
-- posted with its own JE, etc. This table holds that snapshot, plus
-- the new JE id we created so undo can reverse it specifically.
--
-- One row per applied suggestion. reversed_at non-null = already undone;
-- undo is a no-op in that case (idempotent).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.receipt_match_applications (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  suggestion_id varchar NOT NULL,
  receipt_id varchar NOT NULL,
  transaction_id varchar NOT NULL,
  new_journal_entry_id varchar NOT NULL,
  pre_state jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_receipt_match_applications_suggestion
  ON public.receipt_match_applications (suggestion_id);

CREATE INDEX IF NOT EXISTS ix_receipt_match_applications_receipt
  ON public.receipt_match_applications (receipt_id);

CREATE INDEX IF NOT EXISTS ix_receipt_match_applications_transaction
  ON public.receipt_match_applications (transaction_id);
