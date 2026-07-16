-- Organizer Texts: per-org two-way SMS conversations with contacts.
--
-- Model is org-shared, not per-user: a contact who texts the org's
-- Twilio number isn't addressed to anyone in particular, so every
-- org member with texts enabled sees the same threads. Outbound
-- messages carry sent_by_user_id so we can attribute "who replied".
--
-- contact_id is nullable for inbound SMS where the From number
-- doesn't match any contact yet — we still record the message so
-- nothing is lost and the user can attach it to a contact later.
--
-- texts_enabled_at on users is the per-user opt-in gate (mirrors
-- the recorder pattern).
--
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS texts_enabled_at timestamptz;

CREATE TABLE IF NOT EXISTS public.text_messages (
  id                  varchar PRIMARY KEY,
  organization_id     varchar     NOT NULL,
  contact_id          varchar,
  direction           varchar     NOT NULL,   -- 'inbound' | 'outbound'
  from_phone          text        NOT NULL,
  to_phone            text        NOT NULL,
  body                text        NOT NULL,
  status              varchar,                -- 'received' (inbound) | 'queued'|'sent'|'delivered'|'failed' (outbound)
  provider_message_id text,
  segments            integer,
  error               text,
  sent_by_user_id     varchar,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.text_messages
  DROP CONSTRAINT IF EXISTS text_messages_organization_id_fkey,
  ADD  CONSTRAINT text_messages_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.text_messages
  DROP CONSTRAINT IF EXISTS text_messages_contact_id_fkey,
  ADD  CONSTRAINT text_messages_contact_id_fkey
       FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.text_messages
  DROP CONSTRAINT IF EXISTS text_messages_sent_by_user_id_fkey,
  ADD  CONSTRAINT text_messages_sent_by_user_id_fkey
       FOREIGN KEY (sent_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_text_messages_org_created
  ON public.text_messages (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_text_messages_contact_created
  ON public.text_messages (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_text_messages_provider_msg_id
  ON public.text_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
