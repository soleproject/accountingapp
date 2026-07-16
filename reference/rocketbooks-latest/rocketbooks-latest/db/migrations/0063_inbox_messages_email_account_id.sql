-- Link inbox_messages back to the email_accounts row they came from.
--
-- Nullable + ON DELETE SET NULL so disconnecting an account doesn't
-- nuke message history — the rows keep their content and stay
-- queryable, they just lose the back-link. (Cascade-delete here would
-- destroy what may be the only record of the user's reply context.)
--
-- Pre-existing rows (populated via /api/inbox/ingest from other
-- ingesters) will simply have email_account_id IS NULL. The IMAP
-- poller populates it going forward.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS email_account_id varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inbox_messages_email_account_id_fkey'
  ) THEN
    ALTER TABLE public.inbox_messages
      ADD CONSTRAINT inbox_messages_email_account_id_fkey
      FOREIGN KEY (email_account_id) REFERENCES public.email_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_inbox_messages_email_account_id
  ON public.inbox_messages (email_account_id)
  WHERE email_account_id IS NOT NULL;
