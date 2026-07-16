-- AR collections two-step: the client-approval token on the step-1 outreach +
-- a send log for the customer-facing reminders (audit + 7-day dedup).
-- Idempotent.

ALTER TABLE public.ai_client_outreach
  ADD COLUMN IF NOT EXISTS approve_token varchar,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_ai_client_outreach_approve_token
  ON public.ai_client_outreach(approve_token);

CREATE TABLE IF NOT EXISTS public.ar_collection_reminders (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  enterprise_id varchar,
  outreach_id varchar,
  contact_id varchar NOT NULL,
  customer_email varchar,
  invoice_count integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  status varchar NOT NULL,            -- 'sent' | 'skipped' | 'failed'
  error text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ar_reminders_org_contact
  ON public.ar_collection_reminders(organization_id, contact_id, sent_at);
CREATE INDEX IF NOT EXISTS ix_ar_reminders_outreach
  ON public.ar_collection_reminders(outreach_id);
