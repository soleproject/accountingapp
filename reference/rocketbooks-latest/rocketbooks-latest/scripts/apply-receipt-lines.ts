/**
 * One-off: apply migration 0027_receipt_lines.sql.
 * Run with: npx tsx scripts/apply-receipt-lines.ts
 *
 * Idempotent.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.receipt_lines (
      id varchar PRIMARY KEY,
      receipt_id varchar NOT NULL,
      description varchar NOT NULL,
      quantity double precision NOT NULL DEFAULT 1,
      unit_price double precision NOT NULL DEFAULT 0,
      amount double precision NOT NULL,
      expense_account_id varchar,
      category_guess varchar,
      item_name varchar
    );

    CREATE INDEX IF NOT EXISTS ix_receipt_lines_receipt_id
      ON public.receipt_lines (receipt_id);

    ALTER TABLE public.receipt_lines
      ADD COLUMN IF NOT EXISTS suggested_account_id varchar;

    ALTER TABLE public.receipts
      ADD COLUMN IF NOT EXISTS source_account_id varchar;
  `));
  console.log('✓ receipt_lines + receipts.source_account_id ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
