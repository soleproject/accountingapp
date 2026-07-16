-- Per-user "voice" preferences fed into the inbox AI draft prompt.
--
-- Free text: role, tone, do/don't rules, signoff style, escalation
-- preferences. NULL means "no preferences" — the draft job uses its
-- base system prompt only and skips the voice wrapper entirely.
--
-- Soft cap of 2000 chars enforced at the application layer (settings
-- form). Not enforced at the DB level so we can raise the cap without
-- a migration if user feedback says it's tight. Realistically a useful
-- voice doc is 100–500 chars; 2000 is comfortable headroom.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS ai_voice_doc text;
