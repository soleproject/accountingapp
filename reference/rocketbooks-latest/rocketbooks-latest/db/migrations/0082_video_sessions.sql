-- Organizer Video, Phase 1 — call-history persistence (Daily.co).
--
-- One row per room created via POST /api/video/rooms. This is the host-side
-- record of a 1:1 call: who started it, which (private, short-lived) room, and
-- when it expired / ended. Guests are intentionally NOT modeled yet — Phase 3
-- (guest join) will extend this table (e.g. a participants sidecar or a
-- guest_joined_at column) rather than reshape it.
--
-- ended_at is set when the host clicks "Leave" (PATCH /api/video/sessions/:id);
-- it stays NULL for calls that were never explicitly ended (browser closed,
-- room simply expired). expires_at mirrors the Daily room `exp`.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.video_sessions (
  id           varchar PRIMARY KEY,
  host_user_id varchar     NOT NULL,            -- FK to users.id (the call host)
  room_name    varchar     NOT NULL,            -- Daily room name (the join secret)
  room_url     text        NOT NULL,            -- full join URL
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,            -- mirrors the room's Daily `exp`
  ended_at     timestamptz                      -- set on explicit Leave; else NULL
);

ALTER TABLE public.video_sessions
  DROP CONSTRAINT IF EXISTS video_sessions_host_user_id_fkey,
  ADD  CONSTRAINT video_sessions_host_user_id_fkey
       FOREIGN KEY (host_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- History view is "my recent calls, newest first".
CREATE INDEX IF NOT EXISTS ix_video_sessions_host_created
  ON public.video_sessions (host_user_id, created_at DESC);

-- Room name is the lookup key for the end/join flows; it's random + unique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_sessions_room_name
  ON public.video_sessions (room_name);
