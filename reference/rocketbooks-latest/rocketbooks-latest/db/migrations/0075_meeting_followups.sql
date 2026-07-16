-- Meeting follow-up lifecycle, Phase 1.
--
-- Turns a past meeting (an appointments row that HAS a contact) into a
-- tracked follow-up loop:
--
--   awaiting_notes  → meeting ended; we're watching for notes to land
--   chasing_notes   → grace window passed with no notes; a "Get the notes"
--                     task was created for the owner
--   notes_received  → notes landed (recorder/Recall transcript OR a note the
--                     user attached to the meeting); chase task auto-completed
--   debrief_pending → action items extracted; a "Call Debrief" task was
--                     created for the owner to review + approve
--   completed       → owner marked the debrief DONE (= approval); the AI
--                     created tracking tasks for the items it can act on and
--                     logged intended-vs-done
--   skipped         → manually opted out (reserved; not written in Phase 1)
--
-- Scope decision (Phase 1): only appointments with a contact_id enter the
-- loop, so a Google-synced calendar full of personal blocks doesn't generate
-- chase tasks.
--
-- Notes linkage: recordings + notes gain a nullable appointment_id. The
-- recorder path is adopted automatically by the orchestrator (match a ready
-- recording for the same contact inside the meeting's time window); manual
-- notes get linked when create_note is called with an appointmentId.
--
-- All AI-executable follow-up in Phase 1 is INTERNAL ONLY: the AI creates
-- tracking tasks. It never emails or texts attendees. meeting_action_items is
-- the ledger of "what it was supposed to do vs. what it did".
--
-- Additive + idempotent — safe to re-run. Hand-written (schema.ts and the
-- live DB have drifted; we do not round-trip this through drizzle-kit).

-- 1. Link notes back to a meeting.
ALTER TABLE public.recordings   ADD COLUMN IF NOT EXISTS appointment_id varchar;
ALTER TABLE public.notes        ADD COLUMN IF NOT EXISTS appointment_id varchar;

ALTER TABLE public.recordings
  DROP CONSTRAINT IF EXISTS recordings_appointment_id_fkey,
  ADD  CONSTRAINT recordings_appointment_id_fkey
       FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE SET NULL;

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_appointment_id_fkey,
  ADD  CONSTRAINT notes_appointment_id_fkey
       FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_recordings_appointment_id
  ON public.recordings (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_notes_appointment_id
  ON public.notes (appointment_id) WHERE appointment_id IS NOT NULL;

-- 2. The lifecycle state row. One per in-scope appointment.
CREATE TABLE IF NOT EXISTS public.meeting_followups (
  id                varchar PRIMARY KEY,
  organization_id   varchar     NOT NULL,
  user_id           varchar     NOT NULL,   -- the meeting owner; owns generated tasks/notes
  appointment_id    varchar     NOT NULL UNIQUE,
  state             varchar     NOT NULL DEFAULT 'awaiting_notes',
  notes_source      varchar,                -- 'recorder' | 'recall' | 'manual' | null
  recording_id      varchar,                -- the adopted recording, if notes came from one
  chase_task_id     varchar,                -- the "Get the notes" task
  debrief_task_id   varchar,                -- the "Call Debrief" task
  meeting_ended_at  timestamptz NOT NULL,   -- snapshot of ends_at at backfill time
  notes_received_at timestamptz,
  debriefed_at      timestamptz,            -- when the Call Debrief task was created
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meeting_followups
  DROP CONSTRAINT IF EXISTS meeting_followups_organization_id_fkey,
  ADD  CONSTRAINT meeting_followups_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.meeting_followups
  DROP CONSTRAINT IF EXISTS meeting_followups_user_id_fkey,
  ADD  CONSTRAINT meeting_followups_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.meeting_followups
  DROP CONSTRAINT IF EXISTS meeting_followups_appointment_id_fkey,
  ADD  CONSTRAINT meeting_followups_appointment_id_fkey
       FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;
ALTER TABLE public.meeting_followups
  DROP CONSTRAINT IF EXISTS meeting_followups_recording_id_fkey,
  ADD  CONSTRAINT meeting_followups_recording_id_fkey
       FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;

-- Orchestrator drives the machine by scanning rows in a given state.
CREATE INDEX IF NOT EXISTS ix_meeting_followups_state
  ON public.meeting_followups (state, meeting_ended_at);

-- 3. The action-item ledger: what the AI proposed, and what it actually did.
CREATE TABLE IF NOT EXISTS public.meeting_action_items (
  id                varchar PRIMARY KEY,
  organization_id   varchar     NOT NULL,
  followup_id       varchar     NOT NULL,
  appointment_id    varchar     NOT NULL,
  description       text        NOT NULL,
  owner_type        varchar     NOT NULL DEFAULT 'user',  -- 'user' | 'contact'
  owner_contact_id  varchar,                              -- set when a diarized speaker mapped to a contact
  due_hint          text,                                 -- free-text time phrase from the transcript
  executable_by_ai  boolean     NOT NULL DEFAULT true,    -- Phase 1: AI can create a tracking task for it
  proposed_action   jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"kind":"create_task"}
  status            varchar     NOT NULL DEFAULT 'proposed',   -- proposed|approved|executed|failed|skipped
  result_task_id    varchar,                              -- the task the AI created on execution
  result            jsonb,                                -- error detail on failure
  executed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.meeting_action_items
  DROP CONSTRAINT IF EXISTS meeting_action_items_followup_id_fkey,
  ADD  CONSTRAINT meeting_action_items_followup_id_fkey
       FOREIGN KEY (followup_id) REFERENCES public.meeting_followups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_meeting_action_items_followup
  ON public.meeting_action_items (followup_id);
