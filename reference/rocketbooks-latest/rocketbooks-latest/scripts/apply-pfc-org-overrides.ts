/**
 * One-off: apply migration 0025_pfc_org_overrides.sql.
 * Run with: npx tsx scripts/apply-pfc-org-overrides.ts
 *
 * Idempotent — CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join } from 'path';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const before = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'pfc_org_overrides'
    ) AS exists`;
  console.log('table present before:', before[0].exists);

  const sqlText = readFileSync(join(process.cwd(), 'db', 'migrations', '0025_pfc_org_overrides.sql'), 'utf8');
  await sql.unsafe(sqlText);
  console.log('  migration applied');

  const after = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'pfc_org_overrides'
    ) AS exists`;
  console.log('table present after:', after[0].exists);

  if (!after[0].exists) throw new Error('table missing after apply');

  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'pfc_org_overrides'
    ORDER BY indexname`;
  console.log('  indexes:', indexes.map((r) => r.indexname));

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
