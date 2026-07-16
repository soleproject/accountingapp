-- Per-user connected email accounts for the AI inbox feature.
--
-- One row per (user, email_address) pair. Stores app-password
-- credentials encrypted with AES-256-GCM. The encryption key lives in
-- the EMAIL_CREDS_KEY env var (32 random bytes, base64) — NOT in the
-- DB. Per-row IV (encryption_iv) means identical passwords don't share
-- ciphertext. auth_tag is the GCM authentication tag, required for
-- decryption to verify integrity.
--
-- imap_*/smtp_* fields are persisted (instead of derived from
-- provider) so that:
--   1. Generic IMAP/SMTP accounts can store custom hosts/ports.
--   2. We don't break existing rows when a provider changes its
--      recommended ports.
-- For known providers (gmail/yahoo/icloud) the application populates
-- these from a preset registry at insert time.
--
-- connection_status:
--   'ok'             — last poll/test succeeded
--   'auth_failed'    — IMAP rejected creds (revoked app password)
--   'connect_failed' — network/timeout/host unreachable
--   'unknown'        — never tested
--
-- is_active=false suspends polling without deleting the row (useful
-- when re-pasting an app password is in progress).
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.email_accounts (
  id                    varchar PRIMARY KEY,
  user_id               varchar NOT NULL,
  email_address         text    NOT NULL,
  encrypted_password    text    NOT NULL,  -- base64(ciphertext)
  encryption_iv         text    NOT NULL,  -- base64(12 bytes)
  encryption_auth_tag   text    NOT NULL,  -- base64(16 bytes)
  provider              text    NOT NULL,  -- 'gmail'|'yahoo'|'icloud'|'imap'
  imap_host             text    NOT NULL,
  imap_port             integer NOT NULL,
  imap_secure           boolean NOT NULL DEFAULT true,
  smtp_host             text    NOT NULL,
  smtp_port             integer NOT NULL,
  smtp_secure           boolean NOT NULL DEFAULT true,
  last_polled_at        timestamptz,
  last_uid_seen         integer,
  connection_status     text    NOT NULL DEFAULT 'unknown',
  last_error            text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_provider_check'
  ) THEN
    ALTER TABLE public.email_accounts
      ADD CONSTRAINT email_accounts_provider_check
      CHECK (provider IN ('gmail', 'yahoo', 'icloud', 'imap'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_accounts_connection_status_check'
  ) THEN
    ALTER TABLE public.email_accounts
      ADD CONSTRAINT email_accounts_connection_status_check
      CHECK (connection_status IN ('ok', 'auth_failed', 'connect_failed', 'unknown'));
  END IF;
END $$;

-- A user can connect the same mailbox only once. Enforced regardless
-- of case (Gmail treats addresses case-insensitively; we lowercase
-- before insert in the application layer, but the unique index uses
-- lower() as a defensive belt-and-suspenders).
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_accounts_user_address
  ON public.email_accounts (user_id, lower(email_address));

CREATE INDEX IF NOT EXISTS ix_email_accounts_user_id
  ON public.email_accounts (user_id);

CREATE INDEX IF NOT EXISTS ix_email_accounts_active_poll
  ON public.email_accounts (is_active, last_polled_at)
  WHERE is_active = true;
