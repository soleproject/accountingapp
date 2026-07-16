-- Cross-source de-duplication (Plaid feed vs Veryfi bank-statement upload, etc.)
--
-- dedupe_state:
--   'active'    → normal ledger row (default; all existing rows backfilled here)
--   'duplicate' → quarantined duplicate; JE reversed (zero GL impact), hidden from
--                 the ledger + reconciliation, shown only in the "Removed duplicates"
--                 bucket. Never hard-deleted (FK-safe: reconciliation_matches,
--                 statement_lines, ai_recommendations reference transactions.id).
--   'kept_both' → user explicitly overrode a dedupe suggestion to keep both.
-- duplicate_of_id → the surviving transaction this row was deduped against.
--
-- NOT NULL DEFAULT with a constant is a metadata-only change in PG11+ (no table rewrite).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dedupe_state varchar NOT NULL DEFAULT 'active';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS duplicate_of_id varchar;
CREATE INDEX IF NOT EXISTS ix_transactions_dedupe_state
  ON transactions (organization_id, dedupe_state);
