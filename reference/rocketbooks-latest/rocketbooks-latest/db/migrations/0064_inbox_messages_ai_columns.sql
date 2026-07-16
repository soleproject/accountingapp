-- AI draft + send pipeline state for inbox_messages.
--
-- ai_status is parallel and orthogonal to status:
--   status (the EXISTING column) = the user's triage state
--                                  ('open' | 'triaged' | 'archived')
--   ai_status (new)              = the AI pipeline's state
--                                  ('pending' | 'drafted' | 'skipped_noise'
--                                   | 'failed' | 'sent')
--
-- Why separate: a message can be `ai_status='drafted'` but still
-- `status='open'` (AI made a draft, user hasn't acted yet); a message
-- can be `status='archived'` with `ai_status=NULL` (user filed without
-- AI ever touching it — e.g. an SMS row, source != 'email').
--
-- Sending a reply flips both: ai_status='sent', status='triaged'.
--
-- ai_status=NULL means "not relevant" — e.g. SMS rows or other
-- ingester sources we don't draft for. Only the email ingester sets
-- it to 'pending' on insert.
--
-- ai_skip_reason is overloaded:
--   - On 'skipped_noise': which heuristic fired (e.g. 'list-unsubscribe',
--     'no-reply-sender', 'user-dismissed')
--   - On 'failed': the error message
--
-- sent_message_id / sent_at populated only when the user (or a future
-- autonomous path) sends a reply via SMTP.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS ai_status        text,
  ADD COLUMN IF NOT EXISTS ai_draft_subject text,
  ADD COLUMN IF NOT EXISTS ai_draft_html    text,
  ADD COLUMN IF NOT EXISTS ai_draft_text    text,
  ADD COLUMN IF NOT EXISTS ai_model         text,
  ADD COLUMN IF NOT EXISTS ai_drafted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS ai_skip_reason   text,
  ADD COLUMN IF NOT EXISTS sent_message_id  text,
  ADD COLUMN IF NOT EXISTS sent_at          timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inbox_messages_ai_status_check'
  ) THEN
    ALTER TABLE public.inbox_messages
      ADD CONSTRAINT inbox_messages_ai_status_check
      CHECK (ai_status IS NULL OR ai_status IN ('pending', 'drafted', 'skipped_noise', 'failed', 'sent'));
  END IF;
END $$;

-- Drives the draft-cron sweep: "give me the email messages still
-- awaiting an AI draft." Partial index keeps it tiny — most rows are
-- not in 'pending' state.
CREATE INDEX IF NOT EXISTS ix_inbox_messages_pending_drafts
  ON public.inbox_messages (received_at)
  WHERE ai_status = 'pending' AND source = 'email';
