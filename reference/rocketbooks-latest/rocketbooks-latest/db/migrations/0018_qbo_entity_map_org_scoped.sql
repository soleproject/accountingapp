-- The original qbo_entity_map indexes only included realm_id, which broke
-- the multi-org case: when two rocketsuite workspaces connect the same QBO
-- realm (e.g. for testing, or because two orgs legitimately share a QBO
-- file), their mappings collide and counts on /integrations/qbo bleed
-- across orgs. Scope the uniqueness — and every promoter lookup — by
-- (organization_id, realm_id, entity_type, ...) instead.
--
-- Existing rows keep their data; only the indexes change. If two orgs had
-- already connected the same realm before this migration ran, they likely
-- have overlapping rows that satisfied the OLD unique constraint but
-- still satisfy the new one (the new constraint is strictly weaker —
-- adds organization_id to the key — so anything that fit before still
-- fits). Idempotent.

DROP INDEX IF EXISTS public.ix_qbo_entity_map_realm_type_qbo;
DROP INDEX IF EXISTS public.ix_qbo_entity_map_realm_type_local;

CREATE UNIQUE INDEX IF NOT EXISTS ix_qbo_entity_map_org_realm_type_qbo
  ON public.qbo_entity_map (organization_id, realm_id, entity_type, qbo_id);

CREATE UNIQUE INDEX IF NOT EXISTS ix_qbo_entity_map_org_realm_type_local
  ON public.qbo_entity_map (organization_id, realm_id, entity_type, local_id);
