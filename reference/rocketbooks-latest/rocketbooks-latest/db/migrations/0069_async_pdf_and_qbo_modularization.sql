-- RocketSuite modularization: async PDF tracking + QBO sync audit.
-- Generated from QA-approved c141d2ea artifacts and adapted on lbai-dev1.

CREATE TABLE IF NOT EXISTS pdf_jobs (
  id uuid PRIMARY KEY,
  document_record_id uuid NOT NULL REFERENCES document_records(id) ON DELETE CASCADE,
  organization_id varchar REFERENCES organizations(id) ON DELETE CASCADE,
  status varchar NOT NULL DEFAULT 'queued',
  pdf_url text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ix_pdf_jobs_document_record_id ON pdf_jobs(document_record_id);
CREATE INDEX IF NOT EXISTS ix_pdf_jobs_organization_id ON pdf_jobs(organization_id);
CREATE INDEX IF NOT EXISTS ix_pdf_jobs_status ON pdf_jobs(status);

ALTER TABLE pdf_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS qbo_sync_log (
  id uuid PRIMARY KEY,
  organization_id varchar REFERENCES organizations(id) ON DELETE CASCADE,
  realm_id varchar NOT NULL,
  action varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'queued',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ix_qbo_sync_log_organization_id ON qbo_sync_log(organization_id);
CREATE INDEX IF NOT EXISTS ix_qbo_sync_log_realm_id ON qbo_sync_log(realm_id);
CREATE INDEX IF NOT EXISTS ix_qbo_sync_log_status ON qbo_sync_log(status);

ALTER TABLE qbo_sync_log ENABLE ROW LEVEL SECURITY;
