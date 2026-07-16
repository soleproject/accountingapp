/**
 * One-off: apply migration 0101_enterprise_client_products.sql.
 * Run with: npx tsx scripts/apply-0101-enterprise-client-products.ts
 *
 * Idempotent — IF NOT EXISTS on the table + indexes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0101_enterprise_client_products.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0101_enterprise_client_products applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
