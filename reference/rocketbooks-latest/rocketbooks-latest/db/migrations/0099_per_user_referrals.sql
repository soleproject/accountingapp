-- Per-user referrals: a referral link that follows the PERSON across every
-- workspace, crediting the individual user (not the org).
--
-- The existing referral feature is org-scoped (organizations.invite_slug +
-- enterprise_clients). This adds a parallel user-scoped path: each user gets
-- their own slug, the referred org records which user referred it, and a
-- per-user earnings ledger accrues the flat 20% referral share. The org-scoped
-- enterprise/partner path is left untouched.
--
-- Idempotent — safe to re-run.

-- 1. Per-user referral slug. Same 8-char non-confusable alphabet as
--    organizations.invite_slug (lib/referral/user-slug.ts). Handed out as
--    <marketing>/?ref=<referral_slug>. Nullable; minted lazily on first /share.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS referral_slug varchar;

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_referral_slug
  ON public.users (referral_slug)
  WHERE referral_slug IS NOT NULL;

-- 2. Which user referred this org's owner. Set once at signup. NULL = not a
--    user referral (organic, host, or enterprise-org referral).
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS referred_by_user_id varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_referred_by_user_id_fkey'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_referred_by_user_id_fkey
      FOREIGN KEY (referred_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_organizations_referred_by_user
  ON public.organizations (referred_by_user_id);

-- 3. Per-user referral earnings ledger. One row per referred org per billing
--    period; flat referrer_share_cents (no cap). Mirrors
--    enterprise_client_revenue_share but keyed on the referring user.
CREATE TABLE IF NOT EXISTS public.user_referral_revenue_share (
  id                        varchar PRIMARY KEY,
  referrer_user_id          varchar NOT NULL
                              REFERENCES public.users(id) ON DELETE CASCADE,
  referred_organization_id  varchar NOT NULL
                              REFERENCES public.organizations(id) ON DELETE CASCADE,
  referred_subscription_id  varchar
                              REFERENCES public.organization_subscriptions(id) ON DELETE SET NULL,
  billing_period_start      timestamptz NOT NULL,
  billing_period_end        timestamptz NOT NULL,
  client_price_cents        integer NOT NULL,
  referrer_share_cents      integer NOT NULL,
  currency                  varchar(3) NOT NULL DEFAULT 'usd',
  paid_out_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for retried Stripe webhooks: one row per referred org + period.
CREATE UNIQUE INDEX IF NOT EXISTS ix_user_referral_rev_share_org_period
  ON public.user_referral_revenue_share (referred_organization_id, billing_period_start);

CREATE INDEX IF NOT EXISTS ix_user_referral_rev_share_referrer
  ON public.user_referral_revenue_share (referrer_user_id);

CREATE INDEX IF NOT EXISTS ix_user_referral_rev_share_unpaid
  ON public.user_referral_revenue_share (referrer_user_id)
  WHERE paid_out_at IS NULL;
