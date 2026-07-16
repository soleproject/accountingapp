-- Personal finance: category registry + transaction auto-rules.
--
-- personal_categories is the per-user category registry (name + group +
-- rollover/icon metadata). personal_transactions.category stays a text label
-- keyed by category name (matches personal_budgets.category), and this table
-- is what maps a name to its group/rollover for budgets and reports.
--
-- personal_transaction_rules holds merchant/description -> category rules so a
-- recategorization can "apply to all from this merchant" and future synced
-- transactions auto-categorize.
--
-- Additive + idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.personal_categories (
  id varchar PRIMARY KEY,
  user_id varchar NOT NULL,
  name text NOT NULL,
  group_name text NOT NULL DEFAULT 'Other',
  icon text,
  color text,
  rollover boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_personal_categories_user_name
  ON public.personal_categories (user_id, name);
CREATE INDEX IF NOT EXISTS ix_personal_categories_user
  ON public.personal_categories (user_id);

CREATE TABLE IF NOT EXISTS public.personal_transaction_rules (
  id varchar PRIMARY KEY,
  user_id varchar NOT NULL,
  match_field text NOT NULL DEFAULT 'merchant',   -- 'merchant' | 'description'
  match_op text NOT NULL DEFAULT 'contains',      -- 'contains' | 'equals'
  match_value text NOT NULL,
  category_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_personal_transaction_rules_user
  ON public.personal_transaction_rules (user_id);
