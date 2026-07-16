-- The booking/scheduling link a firm provides on the "Client experience"
-- onboarding step when new clients book a setup meeting ("AI books a setup
-- meeting with me"). Either an external scheduling URL (Calendly/Acuity/…) or
-- the firm's own RocketSuite booking page. Used as the CTA href in the client
-- welcome email for the 'meeting' handoff.
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS client_booking_url varchar;
