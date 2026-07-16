-- Ensures transactions.type is always 'deposit' or 'withdrawal'.
--
-- Background: the QBO promote path (lib/qbo/promote/promoter.ts) was inserting
-- transactions rows without setting `type`, which made the Split-transaction
-- button silently disappear for those rows (the page gates on
-- type IN ('deposit','withdrawal')). Every other inserter (Plaid, CSV import,
-- manual create, demo seed) already sets type. This migration backfills the
-- bad rows and adds a guard so the column can't drift back to NULL or to
-- a value the app doesn't understand.

BEGIN;

-- 1. Backfill QBO-origin rows by the deterministic `reference` prefix that
--    the promoter writes. Reference-based (not amount-sign-based) because
--    promoter stores positive `amount` for every kind, so a sign-based
--    backfill would mis-label every purchase as a deposit.
UPDATE transactions
SET type = CASE
  WHEN reference LIKE 'qbo:purchase:%' THEN 'withdrawal'
  WHEN reference LIKE 'qbo:deposit:%'  THEN 'deposit'
  -- Transfer rows are anchored to accountId = fromAccountId, so from that
  -- account's POV money flowed out → 'withdrawal'.
  WHEN reference LIKE 'qbo:transfer:%' THEN 'withdrawal'
END
WHERE type IS NULL
  AND reference LIKE 'qbo:%';

-- 2. Normalize the legacy 'debit'/'credit' values that the demo-fixtures
--    seed used to write (seed has been updated to emit deposit/withdrawal
--    directly going forward). 'debit' = money out, 'credit' = money in.
UPDATE transactions
SET type = CASE type
  WHEN 'debit'  THEN 'withdrawal'
  WHEN 'credit' THEN 'deposit'
END
WHERE type IN ('debit', 'credit');

-- 3. Guard. CHECK rejects any future write that isn't one of the two known
--    values; NOT NULL rejects omissions like the bug this migration fixes.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_known
  CHECK (type IN ('deposit', 'withdrawal'));

ALTER TABLE transactions
  ALTER COLUMN type SET NOT NULL;

COMMIT;
