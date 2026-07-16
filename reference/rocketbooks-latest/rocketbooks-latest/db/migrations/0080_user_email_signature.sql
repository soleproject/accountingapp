-- Move the email signature from an org-level setting to a per-user one.
-- The signature is the block appended to the bottom of every email reply a
-- user sends from the Inbox, and replies go out from each user's personal
-- connected account — so it belongs on the user, not the org.
--
-- 0079 briefly added organizations.letterhead_email_signature; drop it here
-- (it was never populated in real use) and add users.email_signature instead.
-- Idempotent — safe to re-run.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_signature text;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS letterhead_email_signature;
