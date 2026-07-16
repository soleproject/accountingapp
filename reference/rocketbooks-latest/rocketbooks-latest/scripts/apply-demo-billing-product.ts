/**
 * One-off: apply migration 0030_demo_billing_product.sql.
 * Run with: npx tsx scripts/apply-demo-billing-product.ts
 *
 * Idempotent -- only inserts the row if no demo_full product exists.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    INSERT INTO public.billing_products (
      id, name, description, kind, feature_key, period_year,
      unit_amount_cents, currency, active
    )
    SELECT
      'demo_full',
      'Demo Trial',
      '7-day full-access trial for self-serve Enterprise demo signups.',
      'subscription',
      'demo_full',
      NULL,
      0,
      'usd',
      true
    WHERE NOT EXISTS (
      SELECT 1 FROM public.billing_products WHERE feature_key = 'demo_full'
    );
  `));
  console.log('✓ demo_full billing product ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
