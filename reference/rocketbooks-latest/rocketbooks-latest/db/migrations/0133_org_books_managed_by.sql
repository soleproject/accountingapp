-- 0133: per-company "who does the books" for the Add a Company wizard.
-- 'firm' = firm-managed; 'client' = client does the books, firm oversees.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS books_managed_by varchar;
