/**
 * One-off: apply migration 0099_per_user_referrals.sql.
 * Run with: npx tsx scripts/apply-0099-per-user-referrals.ts
 *
 * Idempotent — IF NOT EXISTS on columns, table, indexes, and the FK guard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0099_per_user_referrals.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0099_per_user_referrals applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
