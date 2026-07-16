-- Bill-payment intent on the transaction-record categorize / split flow.
-- When a user categorizes a bank transaction (or one of its split lines)
-- as "Payment Sent for a Bill", we want to:
--   1. Remember which bill the user picked (intent_target_id on the split
--      or — in single-category mode — carried on the linking payments row).
--   2. Link the resulting payments row back to the transaction that funded
--      it (or to the specific split line, when only part of a transaction
--      pays the bill).
--
-- Both columns are nullable so legacy rows keep working unchanged. The
-- categorize / split actions branch on intent='bill_payment' and use
-- intent_target_id (the bill UUID) plus the payment-linkage columns to
-- post the JE and reconcile the bill balance.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.transaction_splits
  ADD COLUMN IF NOT EXISTS intent varchar,
  ADD COLUMN IF NOT EXISTS intent_target_id varchar;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS transaction_id varchar,
  ADD COLUMN IF NOT EXISTS transaction_split_id varchar;

CREATE INDEX IF NOT EXISTS ix_payments_transaction_id
  ON public.payments (transaction_id);
CREATE INDEX IF NOT EXISTS ix_payments_transaction_split_id
  ON public.payments (transaction_split_id);
