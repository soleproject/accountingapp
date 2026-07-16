-- Letterhead settings for generated documents (Task/Create workspace). The
-- letterhead identity (name/address/logo/contact) already lives on the
-- organizations row; these add the document-specific bits that don't:
--   * a default signatory (who signs letters/resolutions, and their title)
--   * a master on/off toggle for the letterhead on generated docs
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS letterhead_signatory_name  varchar,
  ADD COLUMN IF NOT EXISTS letterhead_signatory_title varchar,
  ADD COLUMN IF NOT EXISTS letterhead_enabled         boolean NOT NULL DEFAULT true;
