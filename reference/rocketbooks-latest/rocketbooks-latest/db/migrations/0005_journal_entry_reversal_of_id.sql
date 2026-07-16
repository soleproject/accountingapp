-- reversal_of_id is set on JEs that exist solely to reverse the GL impact
-- of an earlier (incorrect) JE. The cleanup script in commit (c) uses this
-- column to tag the reversing entries it creates for IN-BOOKS orgs (B2 path)
-- so future readers can see the audit chain. Nullable — most JEs are not
-- reversals. Self-referential FK back to journal_entries(id).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS reversal_of_id varchar REFERENCES journal_entries(id);

CREATE INDEX IF NOT EXISTS ix_journal_entries_reversal_of_id
  ON journal_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
