/**
 * One-off: apply migration 0117_accounting_periods.sql.
 * Run with: npx tsx scripts/apply-0117-accounting-periods.ts
 * Idempotent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const ddl = readFileSync(join(process.cwd(), 'db/migrations/0117_accounting_periods.sql'), 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0117_accounting_periods applied.');
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
