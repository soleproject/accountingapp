/**
 * One-off: apply migration 0135_enterprise_staff_archive.sql.
 * Run with: npx tsx scripts/apply-0135-enterprise-staff-archive.ts
 *
 * Idempotent — the column add uses IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0135_enterprise_staff_archive.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0135_enterprise_staff_archive applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
