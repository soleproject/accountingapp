/**
 * One-off: apply migration 0024_drop_coa_slot_unique.sql.
 * Run with: npx tsx scripts/apply-drop-coa-slot-unique.ts
 *
 * Idempotent — DROP CONSTRAINT IF EXISTS is a no-op when the
 * constraint is already gone.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const before = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'chart_of_accounts_org_gaap_detail_unique'
    ) AS exists`;
  console.log('constraint present before:', before[0].exists);

  await sql`ALTER TABLE public.chart_of_accounts DROP CONSTRAINT IF EXISTS chart_of_accounts_org_gaap_detail_unique`;
  console.log('  dropped (or was already absent)');

  const after = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'chart_of_accounts_org_gaap_detail_unique'
    ) AS exists`;
  console.log('constraint present after:', after[0].exists);

  if (after[0].exists) throw new Error('constraint still present after drop');

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
