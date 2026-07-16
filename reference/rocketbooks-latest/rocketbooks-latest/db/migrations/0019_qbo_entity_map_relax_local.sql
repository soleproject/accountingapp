-- Migration 0018 made (organization_id, realm_id, entity_type, local_id) a
-- UNIQUE INDEX. That assumption was wrong: when the promoter merges
-- multiple QBO records into a single local record (e.g. several QBO
-- accounts sharing the same (gaap_type, detail_type) slot collapse into
-- one chart_of_accounts row), we DO want many-to-one mappings. The unique
-- constraint blocks the second-and-later merges from getting a
-- qbo_entity_map row, breaking promotion for the rest.
--
-- Drop the UNIQUE flavor, replace with a plain index (we still need fast
-- reverse lookups from local_id → qbo_id for the outbound mirror path).
-- Idempotent.

DROP INDEX IF EXISTS public.ix_qbo_entity_map_org_realm_type_local;

CREATE INDEX IF NOT EXISTS ix_qbo_entity_map_org_realm_type_local
  ON public.qbo_entity_map (organization_id, realm_id, entity_type, local_id);
