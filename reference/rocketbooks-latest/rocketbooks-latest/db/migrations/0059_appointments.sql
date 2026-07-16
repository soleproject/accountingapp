-- Per-user calendar appointments for the Organizer dashboard.
--
-- This is the internal-storage path; a future Google Calendar OAuth
-- integration would either replace it or sync into it. Keeping the
-- table shape close to Google's (title, description, starts_at, ends_at,
-- location) means that sync becomes a straight field mapping later.
--
-- Scoping mirrors notes:
--   user_id          — owner. Personal calendar.
--   organization_id  — workspace scope (for filtering / future sharing).
--   contact_id       — optional FK; SET NULL on contact delete so we
--                      don't lose appointment history.
--   source           — 'manual' (the user typed it) or 'ai' (the AI
--                      created it from a logged conversation).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.appointments (
  id              varchar PRIMARY KEY,
  user_id         varchar     NOT NULL,
  organization_id varchar     NOT NULL,
  contact_id      varchar,
  title           varchar     NOT NULL,
  description     text,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz,
  location        text,
  source          varchar     NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_user_id_fkey,
  ADD  CONSTRAINT appointments_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_organization_id_fkey,
  ADD  CONSTRAINT appointments_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_contact_id_fkey,
  ADD  CONSTRAINT appointments_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_appointments_user_id_starts_at
  ON public.appointments (user_id, starts_at);

CREATE INDEX IF NOT EXISTS ix_appointments_organization_id_starts_at
  ON public.appointments (organization_id, starts_at);

CREATE INDEX IF NOT EXISTS ix_appointments_contact_id_starts_at
  ON public.appointments (contact_id, starts_at)
  WHERE contact_id IS NOT NULL;
