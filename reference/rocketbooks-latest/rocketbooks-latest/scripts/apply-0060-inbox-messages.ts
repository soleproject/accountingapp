/**
 * One-off: apply migration 0060_inbox_messages.sql.
 * Run with: npx tsx scripts/apply-0060-inbox-messages.ts
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS + DROP/ADD constraint guards
 * + CREATE [UNIQUE] INDEX IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0060_inbox_messages.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0060_inbox_messages applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
