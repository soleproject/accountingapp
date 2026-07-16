-- Per-org map of recurring-task → responsible party ('pro' | 'client'), set by
-- the firm on the business-edit Responsibilities matrix. Catalog of task keys
-- lives in lib/enterprise/task-catalog.ts. Null = use the smart defaults.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS task_responsibilities jsonb;
