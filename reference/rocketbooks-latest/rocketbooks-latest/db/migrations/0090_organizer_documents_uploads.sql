-- Uploaded documents for the organizer Documents page.
--
-- The Documents list previously held only "created" drafts (kind =
-- letter|email|text|resolution|deck, body = the draft text). We now also let
-- users upload existing files (PDFs, Word docs, images). Rather than a second
-- table, uploaded files live in the same organizer_documents row, distinguished
-- by `source`:
--
--   source = 'created'  -> body holds the draft; storage_* are null
--   source = 'uploaded' -> file lives in the organizer-documents bucket;
--                          storage_path/mime_type/file_size/original_filename
--                          are set and body stays empty.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizer_documents
  ADD COLUMN IF NOT EXISTS source            varchar NOT NULL DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS storage_path      text,
  ADD COLUMN IF NOT EXISTS mime_type         varchar,
  ADD COLUMN IF NOT EXISTS file_size         integer,
  ADD COLUMN IF NOT EXISTS original_filename text;
