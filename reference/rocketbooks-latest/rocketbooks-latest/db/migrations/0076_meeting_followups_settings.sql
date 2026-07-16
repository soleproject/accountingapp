-- Meeting follow-up lifecycle, Phase 2 — per-org settings.
--
-- The loop is OFF by default (opt-in per org): this is a multi-tenant DB and
-- the loop creates tasks on users' calendars, so an org turns it on explicitly
-- on /settings. grace_minutes is how long after a meeting ends we wait before
-- creating the "Get the notes" chase task.
--
-- Additive + idempotent. Hand-written (schema.ts ↔ live DB drift).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS meeting_followups_enabled       boolean NOT NULL DEFAULT false;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS meeting_followups_grace_minutes integer NOT NULL DEFAULT 30;
