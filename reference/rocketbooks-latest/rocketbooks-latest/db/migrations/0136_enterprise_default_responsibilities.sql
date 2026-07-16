-- Firm-wide DEFAULT task-responsibility matrix, set on the enterprise org and
-- edited on Enterprise → Settings. Resolution for a client: client override →
-- enterprise default → catalog smart default. Separate from task_responsibilities
-- so it never makes the enterprise org look like a client (no recurring-task gen).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enterprise_default_responsibilities jsonb;
