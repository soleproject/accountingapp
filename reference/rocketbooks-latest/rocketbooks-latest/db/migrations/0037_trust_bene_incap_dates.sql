-- Phase 4d follow-up: point-in-time incapacitation tracking.
--
-- Adds two effective-date columns to trust_beneficiaries so the 815/820
-- qualifying check can be evaluated against the JE date instead of the
-- live `is_incapacitated` flag.
--
--   incapacitated_since      — date the flag was most recently turned ON
--   not_incapacitated_since  — date the flag was most recently turned OFF
--                              (null means it has never been turned off
--                               since the last "on" transition)
--
-- Qualifying-as-of(date) becomes:
--   isIncapacitated AT date ==
--     incapacitated_since IS NOT NULL
--     AND incapacitated_since <= date
--     AND (not_incapacitated_since IS NULL OR date < not_incapacitated_since)
--
-- Backfill: for any row whose live flag is currently TRUE we set
-- incapacitated_since = created_at::date — the safest assumption is "they
-- have been incapacitated for the lifetime of this row." Rows where the
-- flag is currently FALSE get both columns NULL (no incapacitation
-- history on record). The user can edit either via the beneficiary
-- detail page to correct.

ALTER TABLE trust_beneficiaries
  ADD COLUMN IF NOT EXISTS incapacitated_since date,
  ADD COLUMN IF NOT EXISTS not_incapacitated_since date;

UPDATE trust_beneficiaries
SET incapacitated_since = created_at::date
WHERE is_incapacitated = TRUE
  AND incapacitated_since IS NULL;
