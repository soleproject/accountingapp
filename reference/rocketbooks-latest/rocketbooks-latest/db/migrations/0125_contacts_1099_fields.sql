-- 1099 prep: track a vendor/contractor's TIN, W-9 status, and 1099 eligibility
-- on the contact. Additive; all nullable/defaulted so existing rows are valid.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tax_id varchar;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS w9_status varchar NOT NULL DEFAULT 'not_requested';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_1099_eligible boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_contacts_1099_eligible
  ON contacts (organization_id, is_1099_eligible)
  WHERE is_1099_eligible = true;
