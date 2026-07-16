-- Book review findings — the general bookkeeping-correctness counterpart to
-- trust_review_findings (0035). Written by the audit layer (lib/audit/*):
--   • duplicate detection — real-time at import (plaid-promote, manual create)
--     and in the nightly sweep (DUP_EXACT, DUP_NEAR)
--   • integrity sweep — nightly only (BAL_UNBALANCED, BAL_ORPHAN_TXN, BAL_ORPHAN_GL)
--
-- Flag-only: nothing here blocks the autonomous pipeline. Findings surface on
-- the action-card worklist and in the /book-review queue, where the user can
-- merge/keep a duplicate or dismiss an integrity finding (status flips off
-- 'open', preserving the audit trail).
--
-- subject_key is the idempotency key. The audit layer recomputes findings on
-- every run; the unique partial index over (organization_id, code, subject_key)
-- WHERE status='open' collapses repeats to one open row. It exists because:
--   - some findings have no transaction (org-level BAL_UNBALANCED → 'org')
--   - duplicate pairs are symmetric, so we canonicalize to 'dup:<minId>:<maxId>'
--     (scanning either side of the pair yields the same key → one finding)
-- A plain unique index on transaction_id wouldn't dedupe NULLs (each NULL is
-- distinct in Postgres), hence the explicit subject_key.
--
-- FK delete behavior: transaction_id / related_transaction_id / journal_entry_id
-- are ON DELETE SET NULL so resolving a duplicate (deleting the dup txn) keeps
-- the now-resolved finding for the audit trail. organization_id cascades.
--
-- Hand-written (skipping drizzle-kit generate) per the project's schema-drift
-- convention. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.book_review_findings (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  kind varchar(16) NOT NULL,
  code varchar(64) NOT NULL,
  severity varchar(16) NOT NULL,
  subject_key varchar(128) NOT NULL,
  message text NOT NULL,
  transaction_id varchar,
  journal_entry_id varchar,
  related_transaction_id varchar,
  metadata jsonb,
  status varchar(16) NOT NULL DEFAULT 'open',
  resolution varchar(16),
  dismissed_at timestamp with time zone,
  dismissed_by_user_id varchar,
  dismissed_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT book_review_findings_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT book_review_findings_txn_id_fkey
    FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL,
  CONSTRAINT book_review_findings_je_id_fkey
    FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  CONSTRAINT book_review_findings_related_txn_id_fkey
    FOREIGN KEY (related_transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL,
  CONSTRAINT book_review_findings_dismissed_by_user_id_fkey
    FOREIGN KEY (dismissed_by_user_id) REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS ix_book_review_findings_org_status
  ON public.book_review_findings (organization_id, created_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS ix_book_review_findings_txn
  ON public.book_review_findings (transaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_book_review_findings_open_subject
  ON public.book_review_findings (organization_id, code, subject_key)
  WHERE status = 'open';
