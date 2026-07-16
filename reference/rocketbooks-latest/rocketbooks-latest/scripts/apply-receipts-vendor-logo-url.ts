/**
 * One-off: apply migration 0026_receipts_vendor_logo_url.sql.
 * Run with: npx tsx scripts/apply-receipts-vendor-logo-url.ts
 *
 * Idempotent — only adds the column if missing.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    ALTER TABLE public.receipts
      ADD COLUMN IF NOT EXISTS vendor_logo_url varchar;
  `));
  console.log('✓ receipts.vendor_logo_url ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
