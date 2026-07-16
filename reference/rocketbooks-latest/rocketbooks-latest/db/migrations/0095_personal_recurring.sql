-- Personal finance: detected recurring charges / subscriptions / bills.
--
-- One row per recurring series, keyed by (user_id, merchant_key). Detection
-- writes/updates the metric columns; user actions set `status`
-- (active|hidden|cancelled), which the detector preserves on re-scan.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS public.personal_recurring (
  id varchar PRIMARY KEY,
  user_id varchar NOT NULL,
  merchant_key text NOT NULL,
  display_merchant text NOT NULL,
  type text NOT NULL DEFAULT 'expense',   -- 'expense' | 'income'
  cadence text NOT NULL,                   -- weekly|biweekly|monthly|quarterly|annual
  interval_days integer NOT NULL,
  avg_amount numeric(15,2) NOT NULL,       -- absolute amount per occurrence
  last_amount numeric(15,2) NOT NULL,
  last_date date NOT NULL,
  next_date date NOT NULL,
  occurrences integer NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'active',   -- active|hidden|cancelled
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_personal_recurring_user_merchant
  ON public.personal_recurring (user_id, merchant_key);
CREATE INDEX IF NOT EXISTS ix_personal_recurring_user
  ON public.personal_recurring (user_id);
