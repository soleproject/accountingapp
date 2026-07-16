-- Organizer Recorder, Phase 2a — meeting-bot capture source (Recall.ai).
--
-- The bot path reuses the Phase 1 pipeline (recording_segments,
-- recording_outputs, draftSummary, approve → notes/tasks). The ONLY new
-- storage is this sidecar, 1:1 with a recordings row, holding the bits
-- that are specific to a bot session and don't belong on the recordings
-- source-of-truth row.
--
-- Capture flow:
--   dispatch  → insert recordings(source='zoom_bot'|'teams_bot'|'meet_bot',
--               status='scheduled') + recording_bot_sessions(bot_status='dispatched')
--   bot joins → webhook bumps bot_status ('joining' → 'in_call')
--   bot done  → webhook stores media_url, sets recordings.status='transcribing',
--               runs Deepgram + draftSummary, then status='ready' | 'failed'
--
-- recordings.source gains: 'zoom_bot' | 'teams_bot' | 'meet_bot'.
-- recordings.status gains: 'scheduled' (bot dispatched, no media yet),
--   'in_call' (bot recording). Both are plain varchars — no enum to alter.
--
-- consent_ack is required at dispatch: the operator confirms the recording
-- disclosure (the bot also announces itself in-meeting via its display name).
-- We persist it so we can show *who* authorized the recording and when.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.recording_bot_sessions (
  id                varchar PRIMARY KEY,
  recording_id      varchar     NOT NULL UNIQUE,
  recall_bot_id     varchar,                 -- Recall's bot id; null until createBot returns
  platform          varchar     NOT NULL,    -- 'zoom' | 'teams' | 'meet'
  meeting_url       text        NOT NULL,
  bot_status        varchar     NOT NULL,    -- 'dispatched' | 'joining' | 'in_call' | 'done' | 'fatal'
  media_url         text,                    -- downloadable recording URL from Recall (set on done)
  consent_ack       boolean     NOT NULL DEFAULT false,
  consent_by        varchar,                 -- user who acknowledged the recording disclosure
  calendar_event_id varchar,                 -- reserved for Phase 2b auto-join; null for manual dispatch
  last_event        jsonb,                   -- last raw webhook payload, for debugging
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recording_bot_sessions
  DROP CONSTRAINT IF EXISTS recording_bot_sessions_recording_id_fkey,
  ADD  CONSTRAINT recording_bot_sessions_recording_id_fkey
       FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE CASCADE;

ALTER TABLE public.recording_bot_sessions
  DROP CONSTRAINT IF EXISTS recording_bot_sessions_consent_by_fkey,
  ADD  CONSTRAINT recording_bot_sessions_consent_by_fkey
       FOREIGN KEY (consent_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- Webhook lookups arrive keyed by Recall's bot id.
CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_bot_sessions_recall_bot_id
  ON public.recording_bot_sessions (recall_bot_id)
  WHERE recall_bot_id IS NOT NULL;
