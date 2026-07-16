-- Platform-subscription billing catalog + Stripe webhook audit log (PR-1).
--
-- billing_products: super-admin defined products that map a Stripe Price ID
-- to a feature_key (base_seat | current_year_unlock | prior_year). For
-- prior-year unlocks the row is qualified by period_year so each year is a
-- distinct row. unit_amount_cents mirrors the Stripe Price for display; the
-- Stripe Price is the source of truth at charge time.
--
-- billing_events: append-only audit of every Stripe webhook we receive.
-- Unique on stripe_event_id so retries are deduped. processed_at is set
-- by the handler once business logic (added in PR-2) finishes.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.billing_products (
  id varchar PRIMARY KEY,
  name varchar(255) NOT NULL,
  description text,
  kind varchar NOT NULL,
  feature_key varchar NOT NULL,
  period_year integer,
  stripe_product_id varchar,
  stripe_price_id varchar,
  unit_amount_cents integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'usd',
  active boolean NOT NULL DEFAULT true,
  created_by_user_id varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT billing_products_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES public.users (id)
);

-- One product per (feature_key, period_year). period_year is NULL for
-- subscription + current_year_unlock; coalesce so the unique index treats
-- NULL as a single distinct value.
CREATE UNIQUE INDEX IF NOT EXISTS ix_billing_products_feature_year
  ON public.billing_products (feature_key, coalesce(period_year, 0));

CREATE INDEX IF NOT EXISTS ix_billing_products_stripe_price_id
  ON public.billing_products (stripe_price_id);

CREATE TABLE IF NOT EXISTS public.billing_events (
  id varchar PRIMARY KEY,
  stripe_event_id varchar NOT NULL,
  type varchar NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  processed_at timestamp with time zone,
  error text
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_billing_events_stripe_event_id
  ON public.billing_events (stripe_event_id);

CREATE INDEX IF NOT EXISTS ix_billing_events_type
  ON public.billing_events (type);
