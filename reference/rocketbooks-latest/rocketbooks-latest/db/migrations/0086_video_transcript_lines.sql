-- Organizer Video — Complete Session Record, Phase C: live transcript.
--
-- One row per Daily transcription-message (Deepgram-backed live transcription).
-- Captured host-side; participant_id is resolved from daily_session_id (the
-- speaker) via 0084 video_participants. Transcription is a PAID add-on, so it
-- only runs when the host turns the Transcript toggle on.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.video_transcript_lines (
  id             varchar PRIMARY KEY,
  session_id     varchar     NOT NULL,
  participant_id varchar,                       -- resolved speaker; null if unmatched
  speaker_name   varchar     NOT NULL,
  text           text        NOT NULL,
  said_at        timestamptz NOT NULL,
  source         varchar     NOT NULL DEFAULT 'daily_live',
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.video_transcript_lines
  DROP CONSTRAINT IF EXISTS video_transcript_lines_session_id_fkey,
  ADD  CONSTRAINT video_transcript_lines_session_id_fkey
       FOREIGN KEY (session_id) REFERENCES public.video_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.video_transcript_lines
  DROP CONSTRAINT IF EXISTS video_transcript_lines_participant_id_fkey,
  ADD  CONSTRAINT video_transcript_lines_participant_id_fkey
       FOREIGN KEY (participant_id) REFERENCES public.video_participants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_video_transcript_lines_session
  ON public.video_transcript_lines (session_id, said_at);
