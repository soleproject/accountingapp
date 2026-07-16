-- Persist Google Calendar incremental-sync state per connection.
--
-- calendar_sync_token         — opaque token from Google's events.list
--                               nextSyncToken. NULL means "no successful
--                               sync yet — do a full pull next time."
-- calendar_sync_token_updated_at — when we last persisted a new token.
--                                  Useful for diagnostics and for
--                                  detecting stale connections.
--
-- When Google returns 410 Gone on a sync attempt, the token is dead and
-- the application clears this column + does a full window pull. The
-- next successful list then writes a fresh token here.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS calendar_sync_token text;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS calendar_sync_token_updated_at timestamptz;
