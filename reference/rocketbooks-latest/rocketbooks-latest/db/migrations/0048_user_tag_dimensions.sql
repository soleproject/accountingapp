-- User-defined tag dimensions (Class, Location, Department, custom).
-- The polymorphic journal_entry_line_tags table already supports them
-- (entity_type is just a string); these two tables hold the catalog.
--
-- A dimension has a slug (entity_type stored on JE-line tags), a
-- human label, and an emoji. Each dimension has its own value list
-- (e.g. Class → "Marketing", "Engineering"). Values can be archived
-- (hidden from new pickers) without losing historical tags.
--
-- Auto-tag opt-in is deferred — user dimensions don't participate in
-- memory yet because we don't know their semantics. Adding an
-- `auto_tag` column later is non-breaking.

CREATE TABLE IF NOT EXISTS tag_dimensions (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Stored as entity_type on journal_entry_line_tags. Lowercased,
  -- url-safe (a-z 0-9 _-). Org-unique.
  slug varchar NOT NULL,
  label varchar NOT NULL,
  emoji varchar(8),
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT tag_dimensions_org_slug_unique UNIQUE (organization_id, slug)
);
CREATE INDEX IF NOT EXISTS ix_tag_dimensions_org_id ON tag_dimensions (organization_id);

CREATE TABLE IF NOT EXISTS tag_dimension_values (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dimension_id varchar NOT NULL REFERENCES tag_dimensions(id) ON DELETE CASCADE,
  label varchar NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  archived_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT tag_dimension_values_dim_label_unique UNIQUE (dimension_id, label)
);
CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_org_id ON tag_dimension_values (organization_id);
CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_dim_id ON tag_dimension_values (dimension_id);
CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_active
  ON tag_dimension_values (dimension_id)
  WHERE archived_at IS NULL;
