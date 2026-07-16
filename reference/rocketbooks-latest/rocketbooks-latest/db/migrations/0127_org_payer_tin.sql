-- Payer TIN/EIN for 1099-NEC generation (the filing business's own tax ID).
-- Additive; nullable. Org name/address/phone already exist on organizations.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS payer_tin varchar;
