-- Restore the per-account in-scope semantic that M22 removed.
--
-- Default false for ALL existing rows. Plaid auto-promote-on-sync
-- gates on in_scope=true going forward, so personal accounts at the
-- same institution stop polluting business books silently.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.plaid_accounts
  ADD COLUMN IF NOT EXISTS in_scope boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_plaid_accounts_in_scope_org
  ON public.plaid_accounts (linked_organization_id, in_scope);
