-- AI-guided enterprise (accounting-firm) onboarding. Additive; safe to re-run.
-- State machine, mirrored on the client onboarding_state pattern but keyed by
-- the enterprise org and with its own phase set.
CREATE TABLE IF NOT EXISTS enterprise_onboarding_state (
  enterprise_id  varchar PRIMARY KEY,
  phase          varchar NOT NULL DEFAULT 'private_label',
  context        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  completed      boolean NOT NULL DEFAULT false,
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_enterprise_onboarding_completed
  ON enterprise_onboarding_state (completed);

-- Answers the wizard records onto the enterprise org so Settings can reference
-- them. Branding logo columns + private_label + enterprise_tier + invite_slug
-- already exist and are reused.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_assistant_name           varchar;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS brand_color_hex             varchar;  -- captured in P1, applied in P2 theming
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sending_from_email          varchar;  -- captured in P1, real domain sending in P2
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_billing_mode         varchar;  -- 'client_pays' | 'firm_pays'
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_price_mode           varchar;  -- 'discount_69' | 'standard_referral'
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_onboarding_handoff   varchar;  -- 'meeting' | 'self'
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_backend_login_enabled boolean;
