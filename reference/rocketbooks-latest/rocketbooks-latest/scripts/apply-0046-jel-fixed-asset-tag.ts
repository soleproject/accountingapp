/**
 * One-off: apply migration 0046_journal_entry_lines_fixed_asset_tag.sql.
 * Run with: npx tsx scripts/apply-0046-jel-fixed-asset-tag.ts
 *
 * Idempotent — uses IF NOT EXISTS on both ALTER and CREATE INDEX.
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
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'journal_entry_lines' AND column_name = 'fixed_asset_id'
    ) AS exists`;
  console.log('column present before:', before[0].exists);

  await sql`
    ALTER TABLE journal_entry_lines
      ADD COLUMN IF NOT EXISTS fixed_asset_id varchar
        REFERENCES fixed_assets(id) ON DELETE SET NULL`;
  console.log('  alter table done');

  await sql`
    CREATE INDEX IF NOT EXISTS ix_journal_entry_lines_fixed_asset_id
      ON journal_entry_lines (fixed_asset_id)
      WHERE fixed_asset_id IS NOT NULL`;
  console.log('  index created (or already present)');

  const after = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'journal_entry_lines' AND column_name = 'fixed_asset_id'
    ) AS exists`;
  console.log('column present after:', after[0].exists);

  if (!after[0].exists) throw new Error('column still missing after alter');

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
