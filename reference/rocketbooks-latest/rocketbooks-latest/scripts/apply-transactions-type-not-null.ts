/**
 * One-off: apply migration 0022_transactions_type_not_null.sql.
 * Run with: npx tsx scripts/apply-transactions-type-not-null.ts
 *
 * Idempotent — UPDATEs become no-ops on re-run, SET NOT NULL is a no-op
 * when already set, and the CHECK constraint is added only if missing.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const before = await sql`
    SELECT COALESCE(type,'(null)') AS type, COUNT(*)::int AS n
    FROM transactions
    WHERE type IS NULL OR type NOT IN ('deposit','withdrawal')
    GROUP BY 1 ORDER BY 2 DESC`;
  console.log('rows needing repair before:', before);

  await sql.begin(async (tx) => {
    const qboFixed = await tx`
      UPDATE transactions
      SET type = CASE
        WHEN reference LIKE 'qbo:purchase:%' THEN 'withdrawal'
        WHEN reference LIKE 'qbo:deposit:%'  THEN 'deposit'
        WHEN reference LIKE 'qbo:transfer:%' THEN 'withdrawal'
      END
      WHERE type IS NULL AND reference LIKE 'qbo:%'`;
    console.log(`  qbo backfill: ${qboFixed.count} row(s) updated`);

    const legacyFixed = await tx`
      UPDATE transactions
      SET type = CASE type
        WHEN 'debit'  THEN 'withdrawal'
        WHEN 'credit' THEN 'deposit'
      END
      WHERE type IN ('debit','credit')`;
    console.log(`  legacy debit/credit normalize: ${legacyFixed.count} row(s) updated`);

    await tx`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'transactions_type_known'
        ) THEN
          ALTER TABLE transactions
            ADD CONSTRAINT transactions_type_known
            CHECK (type IN ('deposit','withdrawal'));
        END IF;
      END$$;`;
    console.log('  check constraint: ensured');

    await tx`ALTER TABLE transactions ALTER COLUMN type SET NOT NULL`;
    console.log('  not-null: ensured');
  });

  const after = await sql`
    SELECT COALESCE(type,'(null)') AS type, COUNT(*)::int AS n
    FROM transactions
    WHERE type IS NULL OR type NOT IN ('deposit','withdrawal')
    GROUP BY 1 ORDER BY 2 DESC`;
  console.log('rows needing repair after:', after);

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
