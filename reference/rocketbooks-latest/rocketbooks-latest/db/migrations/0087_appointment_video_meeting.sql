-- Calendar: appointments can carry a RocketSuite video meeting + guest list.
--
-- video_enabled : true when the appointment is a video meeting. The Daily room
--                 itself is provisioned on-demand at join time (rooms are
--                 short-lived), and its current join URL is stored in the
--                 existing `location` column.
-- guest_emails  : comma-separated guest emails captured in the create dialog,
--                 shown in the event popover. (No per-guest invite is sent yet.)
--
-- Additive + idempotent — safe to re-run.

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS video_enabled boolean,
  ADD COLUMN IF NOT EXISTS guest_emails  text;
