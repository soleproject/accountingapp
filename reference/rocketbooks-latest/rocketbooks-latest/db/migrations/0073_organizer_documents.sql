-- Standalone documents created in the task-less "Create" workspace. Unlike
-- task_artifacts (one draft bound to a task), these are free-standing docs the
-- user can save and reopen from the documents list. contact_id is optional
-- (future "attach to a contact"). Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.organizer_documents (
  id              varchar PRIMARY KEY,
  organization_id varchar     NOT NULL,
  user_id         varchar,
  kind            varchar     NOT NULL,   -- 'letter' | 'email' | 'text' | 'resolution'
  title           text        NOT NULL DEFAULT '',
  body            text        NOT NULL DEFAULT '',
  contact_id      varchar,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organizer_documents
  DROP CONSTRAINT IF EXISTS organizer_documents_organization_id_fkey,
  ADD  CONSTRAINT organizer_documents_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- contacts.id is varchar in this DB (see schema-drift notes) — FK stays varchar.
ALTER TABLE public.organizer_documents
  DROP CONSTRAINT IF EXISTS organizer_documents_contact_id_fkey,
  ADD  CONSTRAINT organizer_documents_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_organizer_documents_org_user_updated
  ON public.organizer_documents (organization_id, user_id, updated_at DESC);
