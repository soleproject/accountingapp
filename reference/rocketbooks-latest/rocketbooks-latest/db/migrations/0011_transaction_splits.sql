-- Per-transaction splits — the canonical "QB / Xero" shape: a transaction
-- can be allocated across multiple categories, each with its own amount,
-- memo, and contact. The JE is generated from these rows; reports drill
-- the JE so the split is reflected end-to-end.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.transaction_splits (
  id varchar PRIMARY KEY,
  transaction_id varchar NOT NULL,
  organization_id varchar NOT NULL,
  category_account_id varchar NOT NULL,
  amount numeric(14, 2) NOT NULL,
  memo text,
  contact_id varchar,
  position integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_transaction_splits_transaction_id
  ON public.transaction_splits (transaction_id);
CREATE INDEX IF NOT EXISTS ix_transaction_splits_organization_id
  ON public.transaction_splits (organization_id);
CREATE INDEX IF NOT EXISTS ix_transaction_splits_category_account_id
  ON public.transaction_splits (category_account_id);
