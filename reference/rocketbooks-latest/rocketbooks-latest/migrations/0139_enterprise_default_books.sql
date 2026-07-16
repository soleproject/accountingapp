-- Firm-wide DEFAULT for "who does the books", set on the ENTERPRISE org via
-- Enterprise → Settings. Values: 'firm' | 'client' | 'both'. NULL reads as 'both'
-- (the firm has a mix). New client businesses inherit 'firm'/'client'; 'both' means
-- no forced default (the pro chooses per business).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enterprise_default_books_managed_by varchar;
