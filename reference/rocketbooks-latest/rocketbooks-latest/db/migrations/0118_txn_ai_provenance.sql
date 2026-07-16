-- Persist the AI categorizer's confidence, reasoning, and source on each
-- transaction so the accountant review queue can show provenance ("why did
-- the AI pick this, and how sure was it?") without re-running the model per
-- row. Written by server/jobs/auto-categorize.ts when it categorizes a group.
--
-- All columns are nullable and additive: existing rows and the currently
-- deployed code (which selects an explicit column set via the Drizzle schema)
-- are unaffected. Older transactions simply have NULL provenance until the
-- next time the categorizer touches them.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS ai_confidence double precision,
  ADD COLUMN IF NOT EXISTS ai_reason text,
  ADD COLUMN IF NOT EXISTS ai_source varchar,
  ADD COLUMN IF NOT EXISTS ai_categorized_at timestamp;
