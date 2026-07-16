-- Organizer Recorder, Phase 1.
--
-- recordings        — one row per recording session. Owned by a user, scoped
--                     to an org. Optional contact link for the "who was this
--                     with" join. status walks uploading → transcribing →
--                     ready (or failed). storage_path is the bucket key in
--                     supabase storage; bucket is 'recordings'.
-- recording_segments — diarized utterances from Deepgram. speaker_label is
--                     the raw label ('S1', 'S2', …); speaker_user_id /
--                     speaker_contact_id are filled when the user maps the
--                     speaker to a real person on the review screen. channel
--                     distinguishes mic vs tab audio when both are captured.
-- recording_outputs  — AI-drafted summary + action items, derived from the
--                     segments. One row per recording, separate from
--                     recordings so we can regenerate cleanly without
--                     losing the source-of-truth status row.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.recordings (
  id              varchar PRIMARY KEY,
  organization_id varchar     NOT NULL,
  user_id         varchar     NOT NULL,
  contact_id      varchar,
  title           varchar,
  source          varchar     NOT NULL,   -- 'mic' | 'tab' | 'mic+tab'
  status          varchar     NOT NULL,   -- 'uploading' | 'transcribing' | 'ready' | 'failed'
  duration_s      integer,
  storage_path    varchar,
  failure_reason  text,
  started_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recordings
  DROP CONSTRAINT IF EXISTS recordings_organization_id_fkey,
  ADD  CONSTRAINT recordings_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.recordings
  DROP CONSTRAINT IF EXISTS recordings_user_id_fkey,
  ADD  CONSTRAINT recordings_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.recordings
  DROP CONSTRAINT IF EXISTS recordings_contact_id_fkey,
  ADD  CONSTRAINT recordings_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_recordings_org_created_at
  ON public.recordings (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_recordings_user_created_at
  ON public.recordings (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_recordings_status
  ON public.recordings (status)
  WHERE status IN ('uploading', 'transcribing');


CREATE TABLE IF NOT EXISTS public.recording_segments (
  id                  varchar PRIMARY KEY,
  recording_id        varchar     NOT NULL,
  speaker_label       varchar     NOT NULL,
  speaker_user_id     varchar,
  speaker_contact_id  varchar,
  start_ms            integer     NOT NULL,
  end_ms              integer     NOT NULL,
  text                text        NOT NULL,
  channel             varchar,    -- 'mic' | 'tab' | NULL
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recording_segments
  DROP CONSTRAINT IF EXISTS recording_segments_recording_id_fkey,
  ADD  CONSTRAINT recording_segments_recording_id_fkey
       FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE CASCADE;

ALTER TABLE public.recording_segments
  DROP CONSTRAINT IF EXISTS recording_segments_speaker_user_id_fkey,
  ADD  CONSTRAINT recording_segments_speaker_user_id_fkey
       FOREIGN KEY (speaker_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.recording_segments
  DROP CONSTRAINT IF EXISTS recording_segments_speaker_contact_id_fkey,
  ADD  CONSTRAINT recording_segments_speaker_contact_id_fkey
       FOREIGN KEY (speaker_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_recording_segments_recording_start
  ON public.recording_segments (recording_id, start_ms);


CREATE TABLE IF NOT EXISTS public.recording_outputs (
  id              varchar PRIMARY KEY,
  recording_id    varchar     NOT NULL UNIQUE,
  summary_md      text,
  action_items    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  decisions       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  approved_at     timestamptz,
  approved_by     varchar,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.recording_outputs
  DROP CONSTRAINT IF EXISTS recording_outputs_recording_id_fkey,
  ADD  CONSTRAINT recording_outputs_recording_id_fkey
       FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE CASCADE;

ALTER TABLE public.recording_outputs
  DROP CONSTRAINT IF EXISTS recording_outputs_approved_by_fkey,
  ADD  CONSTRAINT recording_outputs_approved_by_fkey
       FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
