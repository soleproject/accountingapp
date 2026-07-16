-- Inbound messages (email, SMS, etc.) that surface on the Organizer
-- dashboard as "issues" the user may need to act on. Populated by
-- external agents (the email ingester, eventually a Twilio inbound
-- webhook) via POST /api/inbox/ingest.
--
-- Idempotency:
--   external_id  — caller-supplied id of the source message (e.g.
--                  IMAP UIDVALIDITY+UID, Twilio MessageSid). Unique
--                  per user when set; lets the ingester safely re-post
--                  without dupes.
--
-- Lifecycle:
--   status='open'      — waiting on the user / AI
--   status='triaged'   — handled (user logged a follow-up, replied,
--                        created a task, etc.). Stays visible in
--                        history queries.
--   status='archived'  — dismissed without action; hidden from the
--                        default "what's open?" view.
--
-- contact_id linkage is best-effort — the ingester or a later
-- enrichment step matches the sender against the contacts table.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.inbox_messages (
  id              varchar PRIMARY KEY,
  user_id         varchar     NOT NULL,
  organization_id varchar     NOT NULL,
  contact_id      varchar,
  source          varchar     NOT NULL,           -- 'email' | 'sms' | 'other'
  from_address    text        NOT NULL,
  from_name       text,
  subject         text,
  body            text        NOT NULL,
  body_html       text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  status          varchar     NOT NULL DEFAULT 'open',  -- 'open' | 'triaged' | 'archived'
  triaged_at      timestamptz,
  external_id     text,
  thread_id       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_user_id_fkey,
  ADD  CONSTRAINT inbox_messages_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_organization_id_fkey,
  ADD  CONSTRAINT inbox_messages_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.inbox_messages
  DROP CONSTRAINT IF EXISTS inbox_messages_contact_id_fkey,
  ADD  CONSTRAINT inbox_messages_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_inbox_messages_user_external
  ON public.inbox_messages (user_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_inbox_messages_user_status_received
  ON public.inbox_messages (user_id, status, received_at DESC);

CREATE INDEX IF NOT EXISTS ix_inbox_messages_organization_id
  ON public.inbox_messages (organization_id);

CREATE INDEX IF NOT EXISTS ix_inbox_messages_contact_id_received
  ON public.inbox_messages (contact_id, received_at DESC)
  WHERE contact_id IS NOT NULL;
