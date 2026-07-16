-- Partial unique index on transactions(organization_id, reference) for non-null
-- references. The plaid promote path and the import flows (CSV / bank-statement)
-- all set reference; manual JE-derived transactions use NULL and are excluded
-- from the constraint.
--
-- Pre-condition: scripts/cleanup-plaid-duplicates.ts must have run first.
-- Otherwise the existing 1,067 cross-COA duplicates from the plaid-sync fanout
-- bug would block index creation.
--
-- Once this index exists, the new plaid-promote.ts code uses ON CONFLICT
-- DO NOTHING with this target to atomically dedupe at the DB layer instead of
-- the racy snapshot pattern it replaced.
CREATE UNIQUE INDEX IF NOT EXISTS ix_transactions_org_reference_uniq
  ON transactions (organization_id, reference)
  WHERE reference IS NOT NULL;
