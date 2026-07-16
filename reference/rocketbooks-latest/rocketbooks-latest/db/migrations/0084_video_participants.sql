-- Organizer Video — Complete Session Record, Phase A.
--
-- Adds participant capture + the call's actual start time, so a finished call
-- has a "who was here, and when" record. Chat + transcript are later phases and
-- will reference these rows for speaker attribution.
--
-- Capture is host-client-driven: the host's browser reports participant
-- join/leave (Daily call-object events) to POST /api/video/sessions/:id/participants.
-- `daily_session_id` is Daily's per-join id and is the attribution key future
-- transcript/chat rows map back to a person with.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.video_sessions
  ADD COLUMN IF NOT EXISTS started_at timestamptz;   -- when the first participant joined

CREATE TABLE IF NOT EXISTS public.video_participants (
  id               varchar PRIMARY KEY,
  session_id       varchar     NOT NULL,
  user_id          varchar,                  -- null for account-less guests
  display_name     varchar     NOT NULL,
  daily_session_id varchar     NOT NULL,     -- provider per-join id (attribution key)
  role             varchar     NOT NULL,     -- 'host' | 'guest'
  joined_at        timestamptz NOT NULL,
  left_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.video_participants
  DROP CONSTRAINT IF EXISTS video_participants_session_id_fkey,
  ADD  CONSTRAINT video_participants_session_id_fkey
       FOREIGN KEY (session_id) REFERENCES public.video_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.video_participants
  DROP CONSTRAINT IF EXISTS video_participants_user_id_fkey,
  ADD  CONSTRAINT video_participants_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- One row per (call, join). Upsert key so repeated join reports are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_participants_session_daily
  ON public.video_participants (session_id, daily_session_id);

CREATE INDEX IF NOT EXISTS ix_video_participants_session
  ON public.video_participants (session_id, joined_at);
