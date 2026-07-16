-- Two welcome-email variants per firm: the existing welcome_email_config is the
-- NEW-client email; welcome_email_config_switching is for clients migrating from
-- another system. enterprise_clients.client_type records which a client is so
-- the right email sends (NULL/'new' = new; 'switching' = migrating).
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS welcome_email_config_switching jsonb;

ALTER TABLE public.enterprise_clients
  ADD COLUMN IF NOT EXISTS client_type varchar;
