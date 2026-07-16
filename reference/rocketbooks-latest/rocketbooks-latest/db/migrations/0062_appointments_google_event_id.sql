-- Track which internal appointments are mirrored to Google Calendar.
--
-- When the AI's create_appointment tool writes to Google, the Google
-- event id lands in this column. The dashboard merge step then drops
-- the Google-API copy on read (since the same event is already in the
-- internal appointments table), so the user sees one row per event
-- instead of a duplicate.
--
-- Partial unique index because most rows will have NULL here (manual
-- internal-only events, AI appointments created before Google was
-- connected). The (user_id, google_event_id) tuple is unique when set
-- so a hypothetical webhook-driven sync can use it as the dedup key.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS google_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_user_google_event
  ON public.appointments (user_id, google_event_id)
  WHERE google_event_id IS NOT NULL;
