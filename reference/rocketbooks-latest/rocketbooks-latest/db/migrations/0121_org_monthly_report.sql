-- Per-org monthly financial-statement report email. When enabled, a cron sends
-- the client (org owner + any extra recipients) a monthly snapshot of the prior
-- month's P&L + balance sheet with a link to the full statements in-app.
-- Additive + opt-in (default off) — no change for existing orgs.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS monthly_report_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_report_recipients text;
