-- AI-phrased command-center headline, cached alongside the month-in-review.
-- Stored with the posture it was generated for, so we only show it while the
-- situation still matches (else fall back to the templated headline). Additive.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_dashboard_headline text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_dashboard_posture varchar;
