-- Link rental_properties to the underlying fixed asset so the property
-- list page can surface cost / book value / depreciation without
-- guessing, and so the rental-property create flow can stand up the
-- balance-sheet entry in one transaction.
--
-- ON DELETE SET NULL so disposing the asset doesn't cascade away the
-- rental record (the property history may outlive the building entry).

ALTER TABLE rental_properties
  ADD COLUMN IF NOT EXISTS fixed_asset_id varchar
    REFERENCES fixed_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_rental_properties_fixed_asset_id
  ON rental_properties (fixed_asset_id)
  WHERE fixed_asset_id IS NOT NULL;
