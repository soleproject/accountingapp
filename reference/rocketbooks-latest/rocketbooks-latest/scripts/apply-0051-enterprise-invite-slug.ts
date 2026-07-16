/**
 * One-off: apply migration 0051_enterprise_invite_slug.sql.
 * Run with: npx tsx scripts/apply-0051-enterprise-invite-slug.ts
 *
 * Idempotent — IF NOT EXISTS on both the column and the unique index.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0051_enterprise_invite_slug.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0051_enterprise_invite_slug applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
