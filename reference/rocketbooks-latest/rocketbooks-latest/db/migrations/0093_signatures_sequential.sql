-- Signatures Phase 2 — sequential signing order + delivery tracking.
--
--   signature_requests.sequential        -> when true, signers are invited one
--                                            at a time in signing_order; the next
--                                            signer is emailed only after the
--                                            previous one finishes.
--   signature_requests.delivery_channels -> csv of channels chosen at send time
--                                            (email,sms,link) so reminders and the
--                                            sequential auto-advance reuse them.
--   signature_recipients.invited_at      -> when this recipient was actually sent
--                                            their link. In sequential mode only
--                                            the active signer has this set, which
--                                            is how we know who to invite next.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.signature_requests
  ADD COLUMN IF NOT EXISTS sequential        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_channels text;

ALTER TABLE public.signature_recipients
  ADD COLUMN IF NOT EXISTS invited_at timestamptz;
