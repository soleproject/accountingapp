-- Custom client welcome-email copy edited in the enterprise onboarding wizard
-- (Client experience step). A JSON object { subject, body, cta }; when absent the
-- preview falls back to the default copy derived from the new-client-setup choice
-- (so "reset" = clear this). Additive.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS welcome_email_config jsonb;
