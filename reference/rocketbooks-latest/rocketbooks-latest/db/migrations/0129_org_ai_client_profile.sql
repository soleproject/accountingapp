-- AI "client profile" memory: how this client likes to work (communication
-- style, a small-amount threshold, standing instructions) plus durable
-- learnings the assistant accumulates via the remember_about_client tool.
-- Read into the AI context on every chat/voice/opener turn; edited in Settings.
-- Nullable jsonb, no backfill — an absent profile reads as defaults.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_client_profile jsonb;
