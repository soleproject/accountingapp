-- Phase 4d foundation: add a per-line beneficiary tag so the rules engine
-- can enforce precise eligibility on 815/820 (Food/Clothing for minors or
-- incapacitated), 310 (taxable distributions → K-1), 635 (medical), 740
-- (education), and per-beneficiary 265.x demand notes.
--
-- Nullable — existing lines stay untagged. New finding code
-- TRUST_BENEFICIARY_LINKAGE_REQUIRED fires when a per-beneficiary account
-- gets a posting without a tag.
--
-- Partial index (WHERE beneficiary_id IS NOT NULL) is what we'll actually
-- query against most of the time — "rows tagged with beneficiary X" or
-- "running balance per beneficiary." Full index would be wasted space
-- given the vast majority of lines will be NULL.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS beneficiary_id varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'journal_entry_lines_beneficiary_id_fkey'
  ) THEN
    ALTER TABLE public.journal_entry_lines
      ADD CONSTRAINT journal_entry_lines_beneficiary_id_fkey
      FOREIGN KEY (beneficiary_id) REFERENCES public.trust_beneficiaries(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_jel_beneficiary_id
  ON public.journal_entry_lines (beneficiary_id)
  WHERE beneficiary_id IS NOT NULL;
