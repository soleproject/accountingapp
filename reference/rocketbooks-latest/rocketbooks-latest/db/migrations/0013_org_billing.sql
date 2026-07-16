-- Per-org subscription state (PR-2).
--
-- organizations.paying_party_user_id — the user the platform charges for
-- this org. Defaults to organizations.owner_user_id at billing time when
-- this is NULL; a super-admin or owner can override later.
--
-- organization_billing — one row per org that has ever opened the billing
-- flow. Tracks the Stripe Customer + the aggregate billing state used by
-- lockout middleware. status is intentionally derived from the org's
-- subscription set so the lockout helper can read one row.
--
-- organization_subscriptions — one row per Stripe subscription on the org.
-- For PR-2 there's only ever the base $89/mo, but the table is plural so
-- add-ons / seat extras / etc. land here without a schema change.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS paying_party_user_id varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'organizations_paying_party_user_id_fkey'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_paying_party_user_id_fkey
      FOREIGN KEY (paying_party_user_id) REFERENCES public.users (id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.organization_billing (
  organization_id varchar PRIMARY KEY,
  paying_party_user_id varchar,
  stripe_customer_id varchar,
  status varchar NOT NULL DEFAULT 'inactive',
  current_period_end timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_billing_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE,
  CONSTRAINT organization_billing_paying_party_user_id_fkey
    FOREIGN KEY (paying_party_user_id) REFERENCES public.users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_organization_billing_stripe_customer_id
  ON public.organization_billing (stripe_customer_id);

CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  billing_product_id varchar NOT NULL,
  stripe_subscription_id varchar NOT NULL,
  status varchar NOT NULL,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_subscriptions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE,
  CONSTRAINT organization_subscriptions_billing_product_id_fkey
    FOREIGN KEY (billing_product_id) REFERENCES public.billing_products (id)
);

-- Defensive: if an earlier CREATE TABLE ran without these columns (the
-- IF NOT EXISTS on CREATE TABLE skips re-creation entirely), add them now
-- so re-running this migration is self-healing.
ALTER TABLE public.organization_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start timestamp with time zone,
  ADD COLUMN IF NOT EXISTS current_period_end timestamp with time zone,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS ix_organization_subscriptions_stripe_subscription_id
  ON public.organization_subscriptions (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS ix_organization_subscriptions_organization_id
  ON public.organization_subscriptions (organization_id);
