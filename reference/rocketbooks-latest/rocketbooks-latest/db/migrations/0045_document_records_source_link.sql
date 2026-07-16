-- Source linkage on document_records — explicit columns so the
-- "find the Bill of Sale for asset X" / "find the doc generated from
-- finding Y" lookups are indexed instead of probing variables jsonb.
-- Needed for the corpus-addition auto-draft + cascade flow: when a
-- deposit gets re-classified or a finding gets dismissed, we need a
-- fast way to find the doc that was spawned from it.
--
-- source_kind taxonomy:
--   'deposit_finding'  — the doc was spawned from a corpus-deposit
--                        classification (TRUST_DEPOSIT_CLASSIFIED_AS_CORPUS
--                        and friends). source_id = finding id.
--   'fixed_asset'      — the doc was spawned from creating a
--                        contributed / inherited asset. source_id =
--                        fixed_assets.id.
--   'manual'           — the user filled the form by hand; source_id
--                        is optional (manual drafts can still
--                        reference an asset or transaction).
--
-- The unique partial index enforces "one auto-spawned doc per
-- (org, source_kind, source_id)" — we don't want classifying the
-- same deposit twice to spawn two drafts. The 'manual' branch isn't
-- unique-constrained: users can create multiple manual docs against
-- the same asset (e.g., revising language after a correction).

ALTER TABLE document_records
  ADD COLUMN IF NOT EXISTS source_kind varchar,
  ADD COLUMN IF NOT EXISTS source_id varchar;

CREATE INDEX IF NOT EXISTS ix_document_records_source
  ON document_records (organization_id, source_kind, source_id)
  WHERE source_kind IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ix_document_records_auto_source_unique
  ON document_records (organization_id, source_kind, source_id)
  WHERE source_kind IS NOT NULL
    AND source_kind <> 'manual'
    AND status <> 'voided';
