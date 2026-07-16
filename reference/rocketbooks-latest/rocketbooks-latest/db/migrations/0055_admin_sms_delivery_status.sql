-- Phase 2 of /super-admin/texts: subscribe to Twilio delivery webhooks.
--
-- Twilio's initial response when we POST to /Messages is just an
-- accept-handshake; the real outcome (delivered / undelivered / failed)
-- arrives later as a StatusCallback POST. To store it we need to:
--   1. Widen the status CHECK to cover the carrier-side states
--      Twilio actually sends (queued, sending, delivered, undelivered,
--      accepted, scheduled, canceled). 'skipped' stays for env-not-
--      configured rows; 'sent' becomes a transient state that usually
--      advances to 'delivered' within seconds.
--   2. Add error_code — Twilio's numeric error (e.g. 30032 "toll-free
--      not verified") which is the actionable bit; the existing 'error'
--      column keeps the human-readable explanation.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.admin_sms
  DROP CONSTRAINT IF EXISTS admin_sms_status_check;

ALTER TABLE public.admin_sms
  ADD CONSTRAINT admin_sms_status_check
  CHECK (status IN (
    'skipped',
    'queued',
    'accepted',
    'scheduled',
    'sending',
    'sent',
    'delivered',
    'undelivered',
    'failed',
    'canceled'
  ));

ALTER TABLE public.admin_sms
  ADD COLUMN IF NOT EXISTS error_code integer;
