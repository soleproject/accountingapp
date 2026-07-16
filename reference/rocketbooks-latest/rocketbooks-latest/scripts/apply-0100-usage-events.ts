/**
 * One-off: apply migration 0100_usage_events.sql.
 * Run with: npx tsx scripts/apply-0100-usage-events.ts
 *
 * Idempotent — IF NOT EXISTS on the columns, table, and indexes; the rate
 * seed uses ON CONFLICT DO NOTHING; the backfill is WHERE category IS NULL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0100_usage_events.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0100_usage_events applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
