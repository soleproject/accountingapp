-- Background job tracking for the beneficiary DOB-correction repost
-- pipeline. The synchronous path was OK for 5-10 JE reposts but blocks
-- the user's tab for 15+ minutes on a 300-JE backfill (each repost
-- runs a reverse + re-post, ~3s per JE). Inngest now owns the work; this
-- table is the polling source for the UI and the audit trail.
--
-- One row per "user clicked Apply on the DOB correction modal."
--   items                : full DobCorrectionItem[] captured at queue
--                          time so a stale preview can't reshape the
--                          work mid-run. Inngest steps slice from this
--                          list, not from a fresh preview.
--   status               : queued → running → completed | failed
--   reposted_count       : monotonically-increasing tally of JEs that
--                          completed their reverse+re-post pair
--   failed_count         : tally of JEs whose repost threw
--   failed_items         : { jeId, error }[] for the failure detail
--                          panel on the beneficiary page
--   progress             : 0-100 integer (percent), for the progress
--                          bar. Always derivable from reposted/total
--                          but stored so a single SELECT covers the UI.
--
-- Indexes scoped to the two access patterns the UI needs:
--   - "is there an active job for THIS beneficiary right now?"
--   - "show the most recent job(s) for this org (audit)"

CREATE TABLE IF NOT EXISTS trust_dob_correction_jobs (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id),
  user_id varchar NOT NULL REFERENCES users(id),
  beneficiary_id varchar NOT NULL REFERENCES trust_beneficiaries(id),

  old_dob date,
  new_dob date NOT NULL,

  items json NOT NULL,
  total_count integer NOT NULL,

  status varchar NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  reposted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  failed_items json,
  error_message text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ix_trust_dob_correction_jobs_bene_status
  ON trust_dob_correction_jobs (beneficiary_id, status);

CREATE INDEX IF NOT EXISTS ix_trust_dob_correction_jobs_org_created
  ON trust_dob_correction_jobs (organization_id, created_at DESC);
