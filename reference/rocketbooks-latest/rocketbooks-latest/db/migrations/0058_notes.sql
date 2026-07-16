-- Per-user notes for the Organizer dashboard. A note can be free-floating
-- (general "today I noticed X") or tied to a specific contact via
-- contact_id. Source records whether the note was typed manually or
-- created by the AI from a conversation log; the dashboard renders both
-- the same way but the badge distinguishes provenance.
--
-- Scoping:
--   user_id          — owner (always set). Notes are personal.
--   organization_id  — workspace scope. Set so per-org filtering / future
--                      sharing within an org is straightforward, and so
--                      the row is naturally pruned if the org is deleted.
--   contact_id       — optional FK; nullable for general notes. Joined
--                      to contacts.id; ON DELETE SET NULL so deleting a
--                      contact doesn't drop the note's history.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.notes (
  id              varchar PRIMARY KEY,
  user_id         varchar     NOT NULL,
  organization_id varchar     NOT NULL,
  contact_id      varchar,
  body            text        NOT NULL,
  source          varchar     NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_user_id_fkey,
  ADD  CONSTRAINT notes_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_organization_id_fkey,
  ADD  CONSTRAINT notes_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.notes
  DROP CONSTRAINT IF EXISTS notes_contact_id_fkey,
  ADD  CONSTRAINT notes_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_notes_user_id_created_at
  ON public.notes (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_notes_organization_id
  ON public.notes (organization_id);

CREATE INDEX IF NOT EXISTS ix_notes_contact_id_created_at
  ON public.notes (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;
