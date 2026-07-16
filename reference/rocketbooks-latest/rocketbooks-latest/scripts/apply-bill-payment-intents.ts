/**
 * One-off: apply migration 0016_bill_payment_intents.sql.
 * Run with: npx tsx scripts/apply-bill-payment-intents.ts
 *
 * Idempotent — re-running is safe; ALTER TABLE … ADD COLUMN IF NOT EXISTS
 * is a no-op when the columns already exist.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    ALTER TABLE public.transaction_splits
      ADD COLUMN IF NOT EXISTS intent varchar,
      ADD COLUMN IF NOT EXISTS intent_target_id varchar;
  `));
  await db.execute(sql.raw(`
    ALTER TABLE public.payments
      ADD COLUMN IF NOT EXISTS transaction_id varchar,
      ADD COLUMN IF NOT EXISTS transaction_split_id varchar;
  `));
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS ix_payments_transaction_id
      ON public.payments (transaction_id);
  `));
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS ix_payments_transaction_split_id
      ON public.payments (transaction_split_id);
  `));
  console.log('✓ bill-payment intent columns applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
