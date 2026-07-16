/**
 * One-off: apply migration 0011_transaction_splits.sql.
 * Run with: npx tsx scripts/apply-transaction-splits.ts
 *
 * Drops + recreates if a partial earlier run left the table in a half
 * state. Empty new feature, so no data to preserve.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`DROP TABLE IF EXISTS public.transaction_splits;`));
  await db.execute(sql.raw(`
    CREATE TABLE public.transaction_splits (
      id varchar PRIMARY KEY,
      transaction_id varchar NOT NULL,
      organization_id varchar NOT NULL,
      category_account_id varchar NOT NULL,
      amount numeric(14, 2) NOT NULL,
      memo text,
      contact_id varchar,
      position integer NOT NULL DEFAULT 0,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `));
  await db.execute(sql.raw(`
    CREATE INDEX ix_transaction_splits_transaction_id
      ON public.transaction_splits (transaction_id);
  `));
  await db.execute(sql.raw(`
    CREATE INDEX ix_transaction_splits_organization_id
      ON public.transaction_splits (organization_id);
  `));
  await db.execute(sql.raw(`
    CREATE INDEX ix_transaction_splits_category_account_id
      ON public.transaction_splits (category_account_id);
  `));
  console.log('✓ transaction_splits table created.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
