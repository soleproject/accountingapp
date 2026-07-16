-- Per-org historical period unlocks (PR-3).
--
-- One row per (organization_id, period_year). Records which SKU was sold
-- so future analytics can tell "current-year unlocks bought late vs.
-- prior-year unlocks bought to migrate from another tool" apart, but the
-- lookup that gates writes only cares about period_year.
--
-- Unique on (org_id, period_year) — an org never needs to buy the same
-- year twice. revoked_at lets a refund logically void the entitlement
-- without leaving a hole in the audit trail.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.organization_entitlements (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  period_year integer NOT NULL,
  billing_product_id varchar NOT NULL,
  stripe_payment_intent_id varchar,
  stripe_checkout_session_id varchar,
  unit_amount_cents integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'usd',
  granted_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_entitlements_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE,
  CONSTRAINT organization_entitlements_billing_product_id_fkey
    FOREIGN KEY (billing_product_id) REFERENCES public.billing_products (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_organization_entitlements_org_year
  ON public.organization_entitlements (organization_id, period_year)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_organization_entitlements_organization_id
  ON public.organization_entitlements (organization_id);
