/**
 * One-off: apply migration 0061_oauth_connections.sql.
 * Run with: npx tsx scripts/apply-0061-oauth-connections.ts
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS + DROP/ADD constraint guard
 * + CREATE [UNIQUE] INDEX IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0061_oauth_connections.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0061_oauth_connections applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
