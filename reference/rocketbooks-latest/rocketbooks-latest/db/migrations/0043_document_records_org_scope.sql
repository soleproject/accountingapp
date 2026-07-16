-- Phase 1 of the Trustee Resolutions & Documentation module.
-- document_records, document_versions, and document_audit_events were
-- shipped in the initial schema dump (migration 0000) but never wired
-- into any flow. Now that we're standing up the trust-documents area,
-- we adopt these tables — only nit is that document_records was
-- scoped by `workspace_id uuid` rather than `organization_id`, which
-- doesn't match how the rest of the app does multi-tenancy. Add the
-- column + index now; leave workspace_id in place for backwards
-- compatibility (no rows exist yet so nothing to migrate).

ALTER TABLE document_records
  ADD COLUMN IF NOT EXISTS organization_id varchar REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS ix_document_records_organization_id
  ON document_records (organization_id);

-- Composite for the top use case: "show me this org's trust docs
-- newest-first." Falls through to the org_id-only index for any
-- single-column lookup.
CREATE INDEX IF NOT EXISTS ix_document_records_org_created
  ON document_records (organization_id, created_at DESC);
