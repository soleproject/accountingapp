import { config } from 'dotenv';
config({ path: '.env.local' });
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

async function main() {
  console.log('=== Existing billing_products rows ===');
  const rows = await db.execute(sql`
    SELECT id, name, kind, feature_key, period_year, unit_amount_cents, stripe_price_id, active
    FROM billing_products
    ORDER BY feature_key, period_year NULLS FIRST
  `);
  console.log(JSON.stringify(rows, null, 2));

  console.log('\n=== CHECK constraints on billing_products ===');
  const checks = await db.execute(sql`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'billing_products' AND con.contype = 'c'
  `);
  console.log(JSON.stringify(checks, null, 2));

  console.log('\n=== Indexes on billing_products ===');
  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'billing_products'
  `);
  console.log(JSON.stringify(idx, null, 2));

  console.log('\n=== Enum types referenced by billing_products ===');
  const enums = await db.execute(sql`
    SELECT a.attname AS column_name, t.typname AS type_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'billing_products' AND a.attnum > 0 AND NOT a.attisdropped
  `);
  console.log(JSON.stringify(enums, null, 2));

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
