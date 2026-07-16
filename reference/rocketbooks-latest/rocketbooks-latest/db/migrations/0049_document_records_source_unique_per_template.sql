-- Expand the auto-draft uniqueness key on document_records to include
-- template_id. Without this, two different auto-draft templates can't
-- both link to the same source row — e.g., a purchased real-property
-- asset wants BOTH a Real Estate Purchase Resolution AND an Insurance
-- Authorization, both with sourceKind='fixed_asset' + sourceId=assetId.
--
-- The pre-existing index (migration 0045) was keyed only on
-- (org, source_kind, source_id). That was sufficient when Bill of Sale
-- was the only auto-draft using fixed_asset linkage, but with the
-- expanded auto-draft surface (RE Purchase, Insurance, Lease) we need
-- to allow one document per (org, source, template) tuple.
--
-- Semantics preserved:
--   - 'manual' kind is still excluded → users can hand-draft as many
--     manual docs as they want
--   - voided docs are excluded → a void + redraft can reuse the same key
--
-- The application layer (draftResolution.ts) is updated in the same
-- commit to match — its existing-doc lookup now also filters by
-- template_id, so a second draftResolution call with a new template
-- against the same source returns null (not the old doc) and goes on
-- to create a new draft.

DROP INDEX IF EXISTS ix_document_records_auto_source_unique;

CREATE UNIQUE INDEX IF NOT EXISTS ix_document_records_auto_source_unique
  ON document_records (organization_id, source_kind, source_id, template_id)
  WHERE source_kind IS NOT NULL
    AND source_kind <> 'manual'
    AND status <> 'voided';
