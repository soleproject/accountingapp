-- Add a long-form description of the business for use in AI context + onboarding.
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS business_description text;
