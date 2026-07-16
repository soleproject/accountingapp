-- Adjusting journal entry flag. Lets accountants mark year-end / adjusting
-- entries (accruals, depreciation, reclasses) distinctly from operational
-- entries so the trial balance can present the standard worksheet:
-- unadjusted → adjustments → adjusted. Additive + nullable-default false, so
-- every existing entry is treated as non-adjusting (unchanged behavior).
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS is_adjusting boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_journal_entries_is_adjusting
  ON journal_entries (is_adjusting) WHERE is_adjusting = true;
