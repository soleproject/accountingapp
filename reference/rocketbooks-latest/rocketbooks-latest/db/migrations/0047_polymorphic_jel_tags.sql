-- Polymorphic per-line tag store. Replaces the typed columns
-- journal_entry_lines.rental_property_id and journal_entry_lines.fixed_asset_id
-- with a single (entity_type, entity_id) shape so the same plumbing
-- supports rental property, fixed asset, loan, and any future tag
-- dimension without a schema change per dimension.
--
-- Backfill is included so existing tags survive the cutover. The old
-- typed columns are left in place for one release as a safety net; a
-- follow-up migration drops them after we've confirmed nothing reads
-- from them.
--
-- Uniqueness: one tag per (line, entity_type) — i.e. a line can be
-- attributed to at most one rental property AND at most one fixed
-- asset AND at most one loan, etc. Two rental properties on the same
-- line wouldn't roll up coherently.

CREATE TABLE IF NOT EXISTS journal_entry_line_tags (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journal_entry_line_id varchar NOT NULL REFERENCES journal_entry_lines(id) ON DELETE CASCADE,
  entity_type varchar NOT NULL,
  entity_id varchar NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT journal_entry_line_tags_unique_dim UNIQUE (journal_entry_line_id, entity_type)
);

CREATE INDEX IF NOT EXISTS ix_jel_tags_org_id
  ON journal_entry_line_tags (organization_id);

CREATE INDEX IF NOT EXISTS ix_jel_tags_entity
  ON journal_entry_line_tags (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS ix_jel_tags_line_id
  ON journal_entry_line_tags (journal_entry_line_id);

-- Backfill rental_property tags from the typed column. ON CONFLICT
-- guards against re-running the migration.
INSERT INTO journal_entry_line_tags (id, organization_id, journal_entry_line_id, entity_type, entity_id)
SELECT
  gen_random_uuid()::varchar,
  je.organization_id,
  jel.id,
  'rental_property',
  jel.rental_property_id
FROM journal_entry_lines jel
JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE jel.rental_property_id IS NOT NULL
ON CONFLICT (journal_entry_line_id, entity_type) DO NOTHING;

-- Backfill fixed_asset tags from the typed column.
INSERT INTO journal_entry_line_tags (id, organization_id, journal_entry_line_id, entity_type, entity_id)
SELECT
  gen_random_uuid()::varchar,
  je.organization_id,
  jel.id,
  'fixed_asset',
  jel.fixed_asset_id
FROM journal_entry_lines jel
JOIN journal_entries je ON je.id = jel.journal_entry_id
WHERE jel.fixed_asset_id IS NOT NULL
ON CONFLICT (journal_entry_line_id, entity_type) DO NOTHING;
