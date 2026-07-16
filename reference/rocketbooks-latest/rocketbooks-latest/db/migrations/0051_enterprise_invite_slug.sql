-- Enterprise invite slug column for shared-domain partner attribution.
--
-- A partner with a tier hands out https://<host>/signup?ref=<invite_slug>
-- to prospects. The signup flow resolves that slug to organizations.id
-- and attaches the new client to that enterprise — alternative to the
-- existing host-based resolution (organizations.domain), which still
-- works for partners with custom DNS.
--
-- 8 chars, non-confusable alphabet (no 0/O/1/l/I/5/S — see
-- lib/enterprise/invite-slug.ts). Unique across all orgs; only set on
-- enterprise-tier orgs by the backfill / ensureInviteSlug helper.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS invite_slug varchar;

-- Partial unique index — only NOT-NULL slugs must be unique; the column
-- is nullable for client orgs and pre-tier enterprises.
CREATE UNIQUE INDEX IF NOT EXISTS ix_organizations_invite_slug
  ON public.organizations (invite_slug)
  WHERE invite_slug IS NOT NULL;
