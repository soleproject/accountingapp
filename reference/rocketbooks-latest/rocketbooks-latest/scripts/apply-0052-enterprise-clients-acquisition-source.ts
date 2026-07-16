/**
 * One-off: apply migration 0052_enterprise_clients_acquisition_source.sql.
 * Run with: npx tsx scripts/apply-0052-enterprise-clients-acquisition-source.ts
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS + guarded constraint + CREATE INDEX IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const sqlPath = join(process.cwd(), 'db/migrations/0052_enterprise_clients_acquisition_source.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0052_enterprise_clients_acquisition_source applied.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
