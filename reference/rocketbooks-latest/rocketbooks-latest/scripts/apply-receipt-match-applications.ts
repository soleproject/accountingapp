/**
 * One-off: apply migration 0029_receipt_match_applications.sql.
 * Run with: npx tsx scripts/apply-receipt-match-applications.ts
 *
 * Idempotent.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.receipt_match_applications (
      id varchar PRIMARY KEY,
      organization_id varchar NOT NULL,
      suggestion_id varchar NOT NULL,
      receipt_id varchar NOT NULL,
      transaction_id varchar NOT NULL,
      new_journal_entry_id varchar NOT NULL,
      pre_state jsonb NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      reversed_at timestamptz
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ix_receipt_match_applications_suggestion
      ON public.receipt_match_applications (suggestion_id);

    CREATE INDEX IF NOT EXISTS ix_receipt_match_applications_receipt
      ON public.receipt_match_applications (receipt_id);

    CREATE INDEX IF NOT EXISTS ix_receipt_match_applications_transaction
      ON public.receipt_match_applications (transaction_id);
  `));
  console.log('✓ receipt_match_applications ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
