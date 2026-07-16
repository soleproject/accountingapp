-- Trust review findings — persistent record of every "warn"-severity finding
-- the beneficial-trust rules engine produced for a posted journal entry.
-- One row per (journal_entry_id, code) pair (rules engine already dedupes
-- by code + accountNumber before persisting, so we keep that grain).
--
-- "block"-severity findings throw a JournalEntryError and never reach the
-- JE insert, so there's no row to record. Only warnings persist here for
-- the user-facing Trust Review queue.
--
-- dismissed_at / dismissed_by_user_id / dismissed_note: the user can
-- acknowledge a finding to remove it from the queue without losing the
-- audit trail. UI filters by `dismissed_at IS NULL` for the default
-- "open" view.
--
-- Hand-written (skipping drizzle-kit generate) per the project's schema-
-- drift convention. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.trust_review_findings (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  journal_entry_id varchar NOT NULL,
  code varchar(64) NOT NULL,
  severity varchar(16) NOT NULL,
  message text NOT NULL,
  metadata jsonb,
  dismissed_at timestamp with time zone,
  dismissed_by_user_id varchar,
  dismissed_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT trust_review_findings_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT trust_review_findings_je_id_fkey
    FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  CONSTRAINT trust_review_findings_dismissed_by_user_id_fkey
    FOREIGN KEY (dismissed_by_user_id) REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS ix_trust_review_findings_org_open
  ON public.trust_review_findings (organization_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_trust_review_findings_je
  ON public.trust_review_findings (journal_entry_id);

CREATE INDEX IF NOT EXISTS ix_trust_review_findings_code
  ON public.trust_review_findings (organization_id, code);
