-- Shared cache for the proactive AI opener greeting so the /ai-chat page and the
-- floating sidecar show the SAME greeting (and we don't call the model twice).
-- Keyed by a signature of the books-state the greeting was generated from, so it
-- auto-refreshes when the situation changes. Additive.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_opener_greeting text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_opener_sig varchar;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_opener_at timestamptz;
