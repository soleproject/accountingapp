-- Per-org automatic review reminders. When enabled, a weekly cron nudges the
-- client about transactions waiting in their review queue (reuses the same
-- per-org review-request outreach + 24h cooldown as the manual button).
-- Opt-in, default off — no change for existing orgs.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS review_auto_outreach_enabled boolean NOT NULL DEFAULT false;
