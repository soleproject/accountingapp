-- AI-suggested 1099 eligibility on contacts. The accountant confirms (Accept
-- flips is_1099_eligible); the suggestion itself never auto-applies. Additive.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_1099_suggestion boolean;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_1099_reason text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_1099_suggested_at timestamptz;
