-- Acquisition source for partner attribution.
--
-- How did this client get attached to its enterprise?
--   invite_link — self-serve signup at /signup (with or without ?ref=).
--                 The enterprise was resolved from either the host or the
--                 invite slug; from the partner's perspective both are
--                 "via their link".
--   manual      — created by an admin via super-admin or enterprise app
--                 (the /clients/new flow).
--   NULL        — legacy rows that pre-date this column. Surfaced as
--                 "Unknown" in dashboards; not back-fillable since we
--                 don't have the original signup channel recorded.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.enterprise_clients
  ADD COLUMN IF NOT EXISTS acquisition_source varchar;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enterprise_clients_acquisition_source_check'
  ) THEN
    ALTER TABLE public.enterprise_clients
      ADD CONSTRAINT enterprise_clients_acquisition_source_check
      CHECK (acquisition_source IS NULL OR acquisition_source IN ('invite_link', 'manual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_enterprise_clients_source
  ON public.enterprise_clients (enterprise_id, acquisition_source);
