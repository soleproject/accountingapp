-- Per-enterprise white-label subdomain (e.g. acme.accountingapp.ai). One DNS
-- label under the platform-owned wildcard (*.accountingapp.ai) so a private-
-- label firm's clients sign in on their own branded host. Distinct from
-- organizations.domain, which is reserved for a future bring-your-own
-- custom-domain tier.
--
-- Idempotent.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS subdomain varchar;

-- At most one enterprise per subdomain (NULLs excluded — most orgs have none).
CREATE UNIQUE INDEX IF NOT EXISTS ix_organizations_subdomain
  ON public.organizations (subdomain)
  WHERE subdomain IS NOT NULL;
