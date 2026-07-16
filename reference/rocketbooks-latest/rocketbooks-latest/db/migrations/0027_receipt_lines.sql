-- Receipt line-item categorization wiring.
--
-- The receipt_lines table is already defined in schema.ts (per-line
-- description / qty / unit_price / amount / expense_account_id /
-- category_guess / item_name) but may not exist in every environment.
-- This migration:
--   1. Ensures receipt_lines exists with the schema.ts shape.
--   2. Adds suggested_account_id so AI's pick is recorded separately
--      from the user's confirmed expense_account_id (we need both so the
--      UI can show "suggested" vs "confirmed" and not silently auto-post).
--   3. Adds receipts.source_account_id — the "paid from" account that
--      lets postReceipt build a balanced JE (debit each line's expense
--      account, credit this source account for the total).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.receipt_lines (
  id varchar PRIMARY KEY,
  receipt_id varchar NOT NULL,
  description varchar NOT NULL,
  quantity double precision NOT NULL DEFAULT 1,
  unit_price double precision NOT NULL DEFAULT 0,
  amount double precision NOT NULL,
  expense_account_id varchar,
  category_guess varchar,
  item_name varchar
);

CREATE INDEX IF NOT EXISTS ix_receipt_lines_receipt_id
  ON public.receipt_lines (receipt_id);

ALTER TABLE public.receipt_lines
  ADD COLUMN IF NOT EXISTS suggested_account_id varchar;

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS source_account_id varchar;
