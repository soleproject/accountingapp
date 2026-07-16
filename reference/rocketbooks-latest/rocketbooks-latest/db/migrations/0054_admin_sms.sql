-- Manual outbound SMS sent from /super-admin/texts.
--
-- Mirrors admin_communications (0053) but for Twilio SMS instead of
-- Resend email. One row per send attempt. status='skipped' is written
-- when TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER aren't all configured,
-- so the table also surfaces attempted sends in environments where SMS
-- is intentionally disabled (matches the lib/sms/twilio.ts no-op path).
--
-- to_phone is stored exactly as Twilio accepted it (E.164 if valid).
-- body is the raw message text the operator typed; segments is the
-- count Twilio billed for (1 message can be 1..N segments depending
-- on length + character set), useful for cost auditing.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.admin_sms (
  id                    varchar PRIMARY KEY,
  sent_by_user_id       varchar NOT NULL,
  to_phone              text    NOT NULL,
  from_phone            text,
  body                  text    NOT NULL,
  status                text    NOT NULL,
  provider_message_id   text,
  segments              integer,
  error                 text,
  sent_at               timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_sms_status_check'
  ) THEN
    ALTER TABLE public.admin_sms
      ADD CONSTRAINT admin_sms_status_check
      CHECK (status IN ('sent', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_admin_sms_sent_at
  ON public.admin_sms (sent_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_sms_sent_by
  ON public.admin_sms (sent_by_user_id);

CREATE INDEX IF NOT EXISTS ix_admin_sms_to_phone
  ON public.admin_sms (to_phone);
