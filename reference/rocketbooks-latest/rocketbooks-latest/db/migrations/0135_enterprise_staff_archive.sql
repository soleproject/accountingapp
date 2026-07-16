-- Enterprise staff archive: soft-remove a staff member from a firm while
-- keeping the record so they can be seen in history and restored later.
-- archived_at IS NULL  => active member (has firm access)
-- archived_at IS NOT NULL => archived (firm access revoked, record retained)
ALTER TABLE enterprise_staff ADD COLUMN IF NOT EXISTS archived_at timestamptz;
