-- Manual outbound emails sent from /super-admin/communications.
--
-- One row per send attempt. status='skipped' is written when
-- RESEND_API_KEY isn't configured, so the table also shows attempted
-- sends in environments where transactional email is intentionally
-- disabled (matches the lib/email/resend.ts no-op behavior).
--
-- body_html and body_text are both nullable but at least one is
-- always populated; the server action validates that before insert.
-- Storing both lets the detail view render exactly what the recipient
-- saw (HTML) and keeps the plain-text fallback addressable for audit.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.admin_communications (
  id                    varchar PRIMARY KEY,
  sent_by_user_id       varchar NOT NULL,
  to_email              text    NOT NULL,
  reply_to              text,
  subject               text    NOT NULL,
  body_html             text,
  body_text             text,
  status                text    NOT NULL,
  provider_message_id   text,
  error                 text,
  sent_at               timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_communications_status_check'
  ) THEN
    ALTER TABLE public.admin_communications
      ADD CONSTRAINT admin_communications_status_check
      CHECK (status IN ('sent', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_admin_communications_sent_at
  ON public.admin_communications (sent_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_communications_sent_by
  ON public.admin_communications (sent_by_user_id);

CREATE INDEX IF NOT EXISTS ix_admin_communications_to_email
  ON public.admin_communications (to_email);
