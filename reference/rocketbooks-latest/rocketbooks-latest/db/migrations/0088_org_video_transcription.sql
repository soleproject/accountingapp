-- Organizer Video — per-org auto-transcription toggle.
--
-- When on, video calls auto-start Daily's (Deepgram-backed, speaker-attributed)
-- live transcription, and the transcript is emailed to the host when the call
-- ends. Off by default — opt-in, since transcription is a paid Daily add-on
-- (~$0.0059/unmuted participant-minute).
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS video_transcription_enabled boolean NOT NULL DEFAULT false;
