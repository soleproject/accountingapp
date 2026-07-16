/**
 * One-off: apply migration 0050_enterprise_tiers.sql.
 * Run with: npx tsx scripts/apply-0050-enterprise-tiers.ts
 *
 * Idempotent — all DDL uses IF NOT EXISTS and the CHECK constraint is
 * guarded by a pg_constraint lookup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0050_enterprise_tiers.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0050_enterprise_tiers applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
