-- Organizer Video — Complete Session Record, Phase B: persisted chat.
--
-- One row per chat message sent during a call. Captured host-side: the host's
-- browser persists its own sends and the messages it receives from the guest
-- (Daily `app-message` data channel), so writes stay authenticated/host-only.
-- daily_session_id is resolved to a participant via 0084's
-- video_participants(session_id, daily_session_id); participant_id is nullable
-- so a message that arrives before its join is recorded still saves.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.video_chat_messages (
  id             varchar PRIMARY KEY,
  session_id     varchar     NOT NULL,
  participant_id varchar,                  -- resolved from daily_session_id; null if unmatched
  sender_name    varchar     NOT NULL,
  text           text        NOT NULL,
  sent_at        timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.video_chat_messages
  DROP CONSTRAINT IF EXISTS video_chat_messages_session_id_fkey,
  ADD  CONSTRAINT video_chat_messages_session_id_fkey
       FOREIGN KEY (session_id) REFERENCES public.video_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.video_chat_messages
  DROP CONSTRAINT IF EXISTS video_chat_messages_participant_id_fkey,
  ADD  CONSTRAINT video_chat_messages_participant_id_fkey
       FOREIGN KEY (participant_id) REFERENCES public.video_participants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_video_chat_messages_session
  ON public.video_chat_messages (session_id, sent_at);
