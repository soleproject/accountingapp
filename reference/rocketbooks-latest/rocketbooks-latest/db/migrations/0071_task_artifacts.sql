-- Task artifacts: the drafted document for an organizer task — the letter /
-- email / text / resolution produced (by the AI or by hand) in the Task
-- Workspace. ONE current draft per task (upserted on task_id), so reopening the
-- task repopulates the canvas with what was last saved.
--
-- kind values: 'letter' | 'email' | 'text' | 'resolution' (validated in the
-- action layer). Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.task_artifacts (
  id              varchar PRIMARY KEY,
  organization_id varchar     NOT NULL,
  task_id         varchar     NOT NULL,
  user_id         varchar,
  kind            varchar     NOT NULL,   -- 'letter' | 'email' | 'text' | 'resolution'
  title           text        NOT NULL DEFAULT '',
  body            text        NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.task_artifacts
  DROP CONSTRAINT IF EXISTS task_artifacts_task_id_fkey,
  ADD  CONSTRAINT task_artifacts_task_id_fkey
       FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

ALTER TABLE public.task_artifacts
  DROP CONSTRAINT IF EXISTS task_artifacts_organization_id_fkey,
  ADD  CONSTRAINT task_artifacts_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- One current draft per task → upsert target.
ALTER TABLE public.task_artifacts
  DROP CONSTRAINT IF EXISTS task_artifacts_unique_task,
  ADD  CONSTRAINT task_artifacts_unique_task UNIQUE (task_id);

CREATE INDEX IF NOT EXISTS ix_task_artifacts_task
  ON public.task_artifacts (task_id);
