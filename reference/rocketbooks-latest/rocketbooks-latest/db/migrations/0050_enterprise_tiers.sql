-- Enterprise tier columns + per-period revenue-share ledger.
--
-- Adds two columns to organizations:
--   enterprise_tier         — pl_495 | pl_995 | cp1 (NULL for non-enterprise
--                              orgs and for legacy enterprises pre-rollout)
--   private_label_enabled   — gates whether the org's logoUrl/poweredByText
--                              replace default RocketSuite chrome for its
--                              clients. Set true automatically when a tier
--                              is assigned.
--
-- Adds enterprise_client_revenue_share: one row per (client org, billing
-- period) recording the partner's share. is_within_cap captures whether
-- the client was inside the tier's included-companies cap at write time;
-- pre-cap rows record the full $50 partner share, post-cap rows record
-- the $25 split share. The platform's share is implicit
-- (client_price_cents - partner_share_cents). Payouts are NOT wired up
-- yet; this is the ledger a future payout job will read.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS enterprise_tier varchar;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS private_label_enabled boolean NOT NULL DEFAULT false;

-- Soft enum guard. Constraint name allows additive tiers later by dropping
-- and recreating; the registry in lib/enterprise/tiers.ts is the source of
-- truth for callers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_enterprise_tier_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_enterprise_tier_check
      CHECK (enterprise_tier IS NULL OR enterprise_tier IN ('pl_495', 'pl_995', 'cp1'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.enterprise_client_revenue_share (
  id varchar PRIMARY KEY,
  enterprise_id varchar NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_organization_id varchar NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_subscription_id varchar REFERENCES public.organization_subscriptions(id) ON DELETE SET NULL,
  enterprise_tier varchar NOT NULL,
  billing_period_start timestamp with time zone NOT NULL,
  billing_period_end timestamp with time zone NOT NULL,
  client_price_cents integer NOT NULL,
  partner_share_cents integer NOT NULL,
  is_within_cap boolean NOT NULL,
  client_index_at_write integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'usd',
  paid_out_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_enterprise_client_rev_share_client_period
  ON public.enterprise_client_revenue_share (client_organization_id, billing_period_start);

CREATE INDEX IF NOT EXISTS ix_enterprise_client_rev_share_enterprise_id
  ON public.enterprise_client_revenue_share (enterprise_id);

-- Partial index — supports the payout job's "what do we owe partner X?"
-- query without scanning historical paid-out rows.
CREATE INDEX IF NOT EXISTS ix_enterprise_client_rev_share_unpaid
  ON public.enterprise_client_revenue_share (enterprise_id)
  WHERE paid_out_at IS NULL;
