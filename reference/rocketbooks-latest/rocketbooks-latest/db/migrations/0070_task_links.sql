-- Task links: relate an organizer task to other entities (notes, meetings,
-- emails, texts) so a task can carry richer context than the single contact
-- that already lives in tasks.assigned_to_contacts.
--
-- Polymorphic store, modeled on journal_entry_line_tags: one
-- (entity_type, entity_id) row per link. Unlike tags, a task may have MANY
-- links of the same type, so the uniqueness is on the full triple.
--
-- entity_type values: 'note' | 'appointment' | 'inbox_message' | 'text_message'.
-- (Contacts intentionally stay on tasks.assigned_to_contacts — already wired
-- into the AI tools, the contact drill-in, and the dashboard company filter.)
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.task_links (
  id              varchar PRIMARY KEY,
  organization_id varchar     NOT NULL,
  task_id         varchar     NOT NULL,
  entity_type     varchar     NOT NULL,   -- 'note' | 'appointment' | 'inbox_message' | 'text_message'
  entity_id       varchar     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_links
  DROP CONSTRAINT IF EXISTS task_links_task_id_fkey,
  ADD  CONSTRAINT task_links_task_id_fkey
       FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

ALTER TABLE public.task_links
  DROP CONSTRAINT IF EXISTS task_links_organization_id_fkey,
  ADD  CONSTRAINT task_links_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.task_links
  DROP CONSTRAINT IF EXISTS task_links_unique_link,
  ADD  CONSTRAINT task_links_unique_link UNIQUE (task_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS ix_task_links_task
  ON public.task_links (task_id);

-- Reverse lookup: "which tasks link to this note / meeting / email / text".
CREATE INDEX IF NOT EXISTS ix_task_links_entity
  ON public.task_links (organization_id, entity_type, entity_id);
