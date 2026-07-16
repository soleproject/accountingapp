-- Cached AI "month in review" narrative for the dashboard. Generated on demand
-- (button), stored here so it isn't regenerated on every page load. Additive.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_dashboard_summary text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_dashboard_summary_at timestamptz;
