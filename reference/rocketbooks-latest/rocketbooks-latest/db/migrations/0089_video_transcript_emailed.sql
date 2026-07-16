-- Organizer Video — transcript email guard.
--
-- Set when the host has been emailed a call's transcript (driven by Daily's
-- transcript.ready-to-download webhook). Prevents duplicate emails if the
-- webhook is retried.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.video_sessions
  ADD COLUMN IF NOT EXISTS transcript_emailed_at timestamptz;
