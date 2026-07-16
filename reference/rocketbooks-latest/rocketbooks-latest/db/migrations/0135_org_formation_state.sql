-- Business registration state + its annual-report due date (MM-DD), set by the
-- firm on the business-edit page. annual_report_due drives the state-filing
-- reminder action card. Both null = no reminder. State deadlines vary too much
-- to hardcode reliably, so the firm owns the date.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS formation_state varchar;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS annual_report_due varchar;
