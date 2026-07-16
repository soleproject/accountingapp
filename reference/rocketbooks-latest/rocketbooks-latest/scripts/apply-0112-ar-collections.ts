/**
 * One-off: apply migration 0112_ar_collections.sql.
 * Run with: npx tsx scripts/apply-0112-ar-collections.ts
 * Idempotent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const ddl = readFileSync(join(process.cwd(), 'db/migrations/0112_ar_collections.sql'), 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0112_ar_collections applied.');
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
