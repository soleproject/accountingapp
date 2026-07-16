/**
 * One-off: apply migration 0067_recordings.sql.
 * Run with: npx tsx scripts/apply-0067-recordings.ts
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS + DROP/ADD constraint guards +
 * CREATE INDEX IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0067_recordings.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0067_recordings applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
