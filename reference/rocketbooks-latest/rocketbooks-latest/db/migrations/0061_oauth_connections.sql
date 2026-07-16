-- Per-user OAuth token storage. Generic across providers so future
-- integrations (Google Drive, Microsoft 365, etc.) reuse the same shape.
--
-- Tokens are encrypted with AES-256-GCM. The encryption key lives in
-- OAUTH_CREDS_KEY (32 random bytes, base64) — NEVER in the DB. Per-row
-- IV (encryption_iv_*) so identical refresh tokens don't share
-- ciphertext, and auth_tag is the GCM authentication tag (required for
-- decryption to verify integrity).
--
-- Why both access and refresh tokens are stored encrypted: Google's
-- access tokens are short-lived (typically 1 hour). Refresh tokens are
-- long-lived (until the user revokes) and are the more sensitive of
-- the two; encrypting both is the safer default.
--
-- Identity:
--   (user_id, provider, account_email) is unique. account_email is the
--   external account the user authorized (their Google email), not the
--   rocketsuite user.email. This lets a single user connect multiple
--   Google accounts down the road without colliding.
--
-- connection_status:
--   'ok'             — last sync succeeded
--   'auth_failed'    — refresh token rejected (user revoked or scope changed)
--   'connect_failed' — non-auth API failure on last sync
--   'unknown'        — never synced
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id                          varchar PRIMARY KEY,
  user_id                     varchar NOT NULL,
  provider                    varchar NOT NULL,            -- 'google' for now
  account_email               text    NOT NULL,
  scope                       text    NOT NULL,
  encrypted_access_token      text    NOT NULL,
  access_iv                   text    NOT NULL,
  access_auth_tag             text    NOT NULL,
  encrypted_refresh_token     text,
  refresh_iv                  text,
  refresh_auth_tag            text,
  expires_at                  timestamptz,
  connection_status           varchar NOT NULL DEFAULT 'unknown',
  connection_error            text,
  last_synced_at              timestamptz,
  connected_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.oauth_connections
  DROP CONSTRAINT IF EXISTS oauth_connections_user_id_fkey,
  ADD  CONSTRAINT oauth_connections_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_oauth_connections_user_provider_account
  ON public.oauth_connections (user_id, provider, account_email);

CREATE INDEX IF NOT EXISTS ix_oauth_connections_user_provider
  ON public.oauth_connections (user_id, provider);
