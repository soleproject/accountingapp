-- Per-user opt-in for the Organizer Recorder.
--
-- Pattern matches the existing sms_opt_in_at / sms_opt_out_at columns:
-- a NULL timestamp means "not enabled," a non-NULL timestamp records
-- when it was turned on. This is checked in addition to (or instead of)
-- the per-org 'recorder' feature pack — see isRecorderEnabled() in
-- lib/recorder/access.ts.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS recorder_enabled_at timestamptz;
