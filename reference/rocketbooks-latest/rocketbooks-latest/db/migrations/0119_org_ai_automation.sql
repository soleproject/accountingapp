-- Per-org AI categorization automation control. Replaces the single global
-- AUTO_CATEGORIZE_CONFIDENCE_THRESHOLD env var with per-org settings the firm
-- can tune from Settings:
--   ai_auto_post_enabled   — when false, the AI still categorizes but never
--                            auto-confirms; every row waits in the review queue.
--   ai_auto_post_threshold — confidence cutoff at/above which a categorization
--                            auto-posts (reviewed=true). NULL → env/0.85 default.
--
-- Additive + nullable; default (enabled=true, threshold=NULL→0.85) preserves the
-- exact behavior of every existing org.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_auto_post_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_auto_post_threshold double precision;
