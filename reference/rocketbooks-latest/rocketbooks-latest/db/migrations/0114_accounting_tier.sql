-- Self-serve accounting plan for CLIENT orgs, replacing the flat $89 plan.
-- Allowed values come from lib/accounting/tiers.ts: 'starter' ($39),
-- 'plus' ($79), 'pro' ($149).
--
-- NULL = grandfathered flat $89 client (legacy base_seat). We do NOT backfill:
-- existing $89 clients stay on NULL and keep the base_seat product. NULL means
-- "legacy plan", never "no plan".
--
-- Plain varchar (no CHECK) to match the organizations.enterprise_tier
-- precedent — the allowed set is enforced in app code (lib/accounting/tiers.ts).
--
-- Idempotent.
-- NOTE: migration number 0114 — verify no parallel agent has also claimed it
-- before applying (see prior 0102/0103 collisions).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS accounting_tier varchar;
