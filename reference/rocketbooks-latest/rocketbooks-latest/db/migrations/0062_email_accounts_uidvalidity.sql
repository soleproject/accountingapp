-- UIDVALIDITY tracking so the IMAP poller can detect mailbox rebuilds.
--
-- IMAP UIDs are only stable within (mailbox, UIDVALIDITY). If the
-- server reports a different UIDVALIDITY than we last recorded, every
-- UID we have is meaningless — we reset last_uid_seen to NULL and let
-- the poller re-watermark from the current state. Without this column
-- a UIDVALIDITY bump would cause us to silently miss new mail (because
-- UIDs would start over below our stored watermark).
--
-- Idempotent — safe to re-run.

ALTER TABLE public.email_accounts
  ADD COLUMN IF NOT EXISTS last_uidvalidity integer;
