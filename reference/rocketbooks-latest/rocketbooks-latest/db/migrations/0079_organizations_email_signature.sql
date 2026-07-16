-- Email signature appended to outgoing email replies (the inbox reply
-- composer). Distinct from the letterhead signatory (who signs generated
-- letters/resolutions) — this is the block that goes at the bottom of every
-- email you send. Org-level, edited on the Letterhead settings page.
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS letterhead_email_signature text;
