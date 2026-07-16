-- Meeting follow-up lifecycle, Phase 2.1 — action-item buckets.
--
-- Each action item is sorted into one of three buckets for the debrief view:
--   'ai'    — RocketSuite can carry it out with its own tools (draft a
--             document, create a note). Executed for real on approval.
--   'user'  — needs the user to send / call / decide / meet. Becomes a task.
--   'other' — belongs to someone else on the call (a mapped contact). Becomes
--             a task assigned to that contact. Internal-only — never contacted.
--
-- result_doc_id holds the organizer_documents row the AI drafted for an 'ai'
-- item (alongside the existing result_task_id for task-producing items).
--
-- Additive + idempotent. Hand-written (schema.ts <-> live DB drift).

ALTER TABLE public.meeting_action_items
  ADD COLUMN IF NOT EXISTS bucket        varchar NOT NULL DEFAULT 'user';
ALTER TABLE public.meeting_action_items
  ADD COLUMN IF NOT EXISTS result_doc_id varchar;
