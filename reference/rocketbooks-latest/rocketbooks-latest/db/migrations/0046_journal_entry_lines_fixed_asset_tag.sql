-- Add a fixed_asset_id tag to journal_entry_lines, mirroring how
-- rental_property_id already lets a line be attributed to a property.
-- This lets a user say "this $400 repair was for the refrigerator
-- (Asset #FA-123)" so per-asset spend (capex, maintenance, etc.) can
-- be rolled up on the asset's detail page.
--
-- Tag-style FK with ON DELETE SET NULL — deleting an asset shouldn't
-- delete the historical JEs that referenced it.

ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS fixed_asset_id varchar
    REFERENCES fixed_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_journal_entry_lines_fixed_asset_id
  ON journal_entry_lines (fixed_asset_id)
  WHERE fixed_asset_id IS NOT NULL;
