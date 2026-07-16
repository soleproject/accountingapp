-- GoHighLevel (GHL) integration — Phase 1 (additive, ingestion-only).
--
-- Mirrors the Plaid three-layer stack but stops BEFORE auto-posting
-- revenue: a GHL payment is a revenue *event* (who paid, for which
-- invoice), not cash in the bank. Cash truth still comes from the Plaid
-- bank feed, and GHL records are reconciled against it. Auto-posting
-- revenue via an undeposited-funds clearing account is deferred to
-- Phase 2 (it would otherwise double-count against the Plaid deposit
-- the same money produces a day or two later).
--
-- Three tables, all NEW — nothing here touches plaid_* / transactions /
-- reconciliation, so non-GHL orgs are unaffected:
--
--   ghl_connections   — one OAuth connection per (org, GHL location).
--                       QBO-style: access + refresh tokens, encrypted
--                       at rest as AES-256-GCM payloads (iv:tag:enc) via
--                       the GHL_ENCRYPTION_KEY env var — ciphertext only,
--                       never plaintext, lives in these columns.
--   ghl_raw_payments  — raw landing table (cf. plaid_raw_transactions).
--                       UNIQUE(ghl_connection_id, ghl_payment_id) makes
--                       webhook re-delivery and backfill overlap no-ops.
--   ghl_oauth_states  — one-shot CSRF state for the OAuth round-trip
--                       (cf. qbo_oauth_states), carrying the initiating
--                       user + org. Consumed and deleted in the callback.
--
-- Ledger-level dedup reuses the existing transactions.reference guard
-- with a new 'ghl:<payment_id>' prefix — no schema change to transactions.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.ghl_connections (
  id                        varchar PRIMARY KEY,
  user_id                   varchar NOT NULL,        -- who connected
  organization_id           varchar NOT NULL,        -- owning org
  location_id               varchar NOT NULL,        -- GHL sub-account / location id
  access_token              varchar NOT NULL,        -- AES-256-GCM payload (iv:tag:enc)
  refresh_token             varchar NOT NULL,        -- AES-256-GCM payload (iv:tag:enc)
  access_token_expires_at   timestamptz NOT NULL,    -- GHL access tokens are short-lived (~24h)
  refresh_token_expires_at  timestamptz,             -- nullable: GHL refresh tokens rotate, no fixed expiry
  connection_status         varchar NOT NULL DEFAULT 'connected',  -- 'connected'|'error'|'disconnected'
  sync_cursor               varchar,                 -- pagination / last-seen watermark for incremental sync
  last_synced_at            timestamptz,
  last_sync_error           varchar,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ghl_connections_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT ghl_connections_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id)
);

-- One connection per location per org (re-connect updates the row in place).
CREATE UNIQUE INDEX IF NOT EXISTS ix_ghl_connections_org_location_uniq
  ON public.ghl_connections (organization_id, location_id);

CREATE INDEX IF NOT EXISTS ix_ghl_connections_organization_id
  ON public.ghl_connections (organization_id);

CREATE INDEX IF NOT EXISTS ix_ghl_connections_location_id
  ON public.ghl_connections (location_id);

CREATE TABLE IF NOT EXISTS public.ghl_raw_payments (
  id                varchar PRIMARY KEY,
  ghl_connection_id varchar NOT NULL,
  ghl_payment_id    varchar NOT NULL,               -- GHL's payment/transaction id
  date              date NOT NULL,
  amount            numeric(18, 2) NOT NULL,
  contact_name      varchar,                          -- denormalized from payload for contact resolution
  description       varchar,
  raw_json          json NOT NULL,                    -- full GHL payment object
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ghl_raw_payments_ghl_connection_id_fkey
    FOREIGN KEY (ghl_connection_id) REFERENCES public.ghl_connections(id)
);

-- Idempotency guard: same payment re-delivered (webhook replay or
-- backfill overlap) hits this and is dropped via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS ix_ghl_raw_payments_uniq
  ON public.ghl_raw_payments (ghl_connection_id, ghl_payment_id);

CREATE INDEX IF NOT EXISTS ix_ghl_raw_payments_ghl_connection_id
  ON public.ghl_raw_payments (ghl_connection_id);

CREATE INDEX IF NOT EXISTS ix_ghl_raw_payments_ghl_payment_id
  ON public.ghl_raw_payments (ghl_payment_id);

CREATE TABLE IF NOT EXISTS public.ghl_oauth_states (
  id              varchar PRIMARY KEY,
  state           varchar(255) NOT NULL,
  user_id         varchar NOT NULL,
  org_id          varchar,
  return_context  varchar(50),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT ghl_oauth_states_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT ghl_oauth_states_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_ghl_oauth_states_state
  ON public.ghl_oauth_states (state);
