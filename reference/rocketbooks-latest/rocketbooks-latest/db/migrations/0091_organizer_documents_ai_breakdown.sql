-- Persisted AI breakdown for the document view page.
--
-- The view page (/organizer/documents/[id]) shows an AI summary of what a
-- document is and what it's for. Generating it on every visit re-bills the
-- model, so we cache the result on the row:
--
--   ai_breakdown      -> the structured breakdown JSON
--   ai_breakdown_hash -> hash of the analyzed content at generation time;
--                        when the live content hashes differently the saved
--                        breakdown is stale and the UI offers to rerun it.
--   ai_breakdown_at   -> when it was generated
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizer_documents
  ADD COLUMN IF NOT EXISTS ai_breakdown      jsonb,
  ADD COLUMN IF NOT EXISTS ai_breakdown_hash text,
  ADD COLUMN IF NOT EXISTS ai_breakdown_at   timestamptz;
