-- Adds Veryfi document metadata columns to imports table.
-- Idempotent — safe to re-run.

ALTER TABLE public.imports
  ADD COLUMN IF NOT EXISTS veryfi_document_id varchar,
  ADD COLUMN IF NOT EXISTS veryfi_raw_json text;
