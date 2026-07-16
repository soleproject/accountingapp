-- Step 1: Cross-account cleanup. plaid-sync pre-fix (before commit (a) of
-- this branch) wrote each Plaid txn to every account in the linked item,
-- regardless of which sub-account it actually belonged to. The "wrong-owner"
-- rows have a plaid_account_id (our internal UUID) whose corresponding
-- plaid_accounts.plaid_account_id (Plaid's id) doesn't match the raw_json's
-- account_id. Delete those.
DELETE FROM plaid_raw_transactions prt
WHERE NOT EXISTS (
  SELECT 1 FROM plaid_accounts pa
  WHERE pa.id = prt.plaid_account_id
    AND pa.plaid_account_id = ((prt.raw_json::jsonb) ->> 'account_id')
);

-- Step 2: Within-account cleanup. Belt-and-suspenders for any same-pair
-- duplicates (none expected in current production data, but cheap to enforce).
-- Keeps the row with the smallest created_at per (plaid_account_id,
-- plaid_transaction_id) group.
DELETE FROM plaid_raw_transactions
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY plaid_account_id, plaid_transaction_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
    FROM plaid_raw_transactions
  ) t
  WHERE t.rn > 1
);

-- Step 3: Backstop for future within-account double-inserts (commit (a)
-- prevents cross-account fanout in code; this index catches anything that
-- slips through and makes the existing .onConflictDoNothing() in plaid-sync.ts
-- load-bearing for the first time).
CREATE UNIQUE INDEX IF NOT EXISTS ix_plaid_raw_transactions_uniq
  ON plaid_raw_transactions (plaid_account_id, plaid_transaction_id);
