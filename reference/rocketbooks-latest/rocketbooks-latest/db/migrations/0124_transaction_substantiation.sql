-- IRS substantiation documentation, stored separately and linked to the
-- transaction it supports. The system detects substantiation-required
-- transactions (meals, travel, lodging, gifts, vehicle, charitable), asks the
-- client for the IRS-required fields by email, and stores the reply here.
CREATE TABLE IF NOT EXISTS transaction_substantiation (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  transaction_id varchar NOT NULL,
  doc_type varchar NOT NULL,          -- meal | travel | lodging | gift | vehicle | charitable
  status varchar NOT NULL DEFAULT 'needed',  -- needed | requested | provided
  fields jsonb,                       -- the collected IRS fields (per doc_type schema)
  requested_at timestamptz,
  provided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_txn_subst_org_txn ON transaction_substantiation (organization_id, transaction_id);
CREATE INDEX IF NOT EXISTS ix_txn_subst_org_status ON transaction_substantiation (organization_id, status);

-- Opt-in for the weekly cron that emails clients for missing substantiation.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS substantiation_enabled boolean NOT NULL DEFAULT false;
