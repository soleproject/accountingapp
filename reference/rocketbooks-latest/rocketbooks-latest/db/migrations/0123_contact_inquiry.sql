-- "What's this?" contact-inquiry loop. The system emails the client about
-- recent transactions whose contact is unknown; the client replies in plain
-- English; the AI applies the answer (categorize + contact + optional rule).
--
-- ai_client_outreach.context stores which transactions a contact_inquiry email
-- referenced, so an inbound reply (matched by the existing reply-to token) can
-- be applied to exactly those transactions.
-- organizations.contact_inquiry_enabled opts an org into the daily inquiry cron.
-- Additive + opt-in; dormant until inbound email is configured.
ALTER TABLE ai_client_outreach
  ADD COLUMN IF NOT EXISTS context jsonb;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS contact_inquiry_enabled boolean NOT NULL DEFAULT false;
