-- Loan → asset collateral link.
--
-- Adds a nullable FK from loans.collateral_asset_id → fixed_assets.id.
-- Single-asset link covers the 90% case (purchase-money mortgage on a
-- building, auto loan on a vehicle, equipment financing). When a real
-- need for multi-asset collateral comes up (cross-collateralized
-- portfolio loans, master credit facilities), upgrade to a join table.
--
-- ON DELETE SET NULL so disposing the asset doesn't cascade and nuke
-- the loan history — the loan stays around as an unsecured note (the
-- trustee gets a finding in Trust Review when the link drops while the
-- loan still has a balance).

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS collateral_asset_id varchar,
  ADD CONSTRAINT loans_collateral_asset_id_fkey
    FOREIGN KEY (collateral_asset_id) REFERENCES fixed_assets(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_loans_collateral_asset_id
  ON loans (collateral_asset_id)
  WHERE collateral_asset_id IS NOT NULL;
