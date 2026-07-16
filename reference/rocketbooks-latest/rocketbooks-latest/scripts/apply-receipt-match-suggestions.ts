/**
 * One-off: apply migration 0028_receipt_match_suggestions.sql.
 * Run with: npx tsx scripts/apply-receipt-match-suggestions.ts
 *
 * Idempotent.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.receipt_match_suggestions (
      id varchar PRIMARY KEY,
      organization_id varchar NOT NULL,
      receipt_id varchar NOT NULL,
      transaction_id varchar NOT NULL,
      confidence numeric(4, 3) NOT NULL,
      amount_diff numeric(12, 2) NOT NULL,
      date_diff_days integer NOT NULL,
      vendor_match boolean NOT NULL DEFAULT false,
      status varchar NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ix_receipt_match_suggestions_receipt_txn
      ON public.receipt_match_suggestions (receipt_id, transaction_id);

    CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_org_status
      ON public.receipt_match_suggestions (organization_id, status);

    CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_receipt
      ON public.receipt_match_suggestions (receipt_id);

    CREATE INDEX IF NOT EXISTS ix_receipt_match_suggestions_transaction
      ON public.receipt_match_suggestions (transaction_id);
  `));
  console.log('✓ receipt_match_suggestions ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
