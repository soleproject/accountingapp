/**
 * One-off: apply migration 0047_polymorphic_jel_tags.sql.
 * Run with: npx tsx scripts/apply-0047-polymorphic-jel-tags.ts
 *
 * Idempotent — uses IF NOT EXISTS on schema objects and ON CONFLICT
 * on backfill inserts.
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
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'journal_entry_line_tags'
    ) AS exists`;
  console.log('table present before:', before[0].exists);

  await sql`
    CREATE TABLE IF NOT EXISTS journal_entry_line_tags (
      id varchar PRIMARY KEY,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      journal_entry_line_id varchar NOT NULL REFERENCES journal_entry_lines(id) ON DELETE CASCADE,
      entity_type varchar NOT NULL,
      entity_id varchar NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT journal_entry_line_tags_unique_dim UNIQUE (journal_entry_line_id, entity_type)
    )`;
  console.log('  table created (or already present)');

  await sql`CREATE INDEX IF NOT EXISTS ix_jel_tags_org_id ON journal_entry_line_tags (organization_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ix_jel_tags_entity ON journal_entry_line_tags (entity_type, entity_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ix_jel_tags_line_id ON journal_entry_line_tags (journal_entry_line_id)`;
  console.log('  indexes created (or already present)');

  const beforeRows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM journal_entry_line_tags`;
  console.log('  tag rows before backfill:', beforeRows[0].n);

  const rpResult = await sql`
    INSERT INTO journal_entry_line_tags (id, organization_id, journal_entry_line_id, entity_type, entity_id)
    SELECT
      gen_random_uuid()::varchar,
      je.organization_id,
      jel.id,
      'rental_property',
      jel.rental_property_id
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.rental_property_id IS NOT NULL
    ON CONFLICT (journal_entry_line_id, entity_type) DO NOTHING`;
  console.log('  rental_property backfill rowcount:', rpResult.count);

  const faResult = await sql`
    INSERT INTO journal_entry_line_tags (id, organization_id, journal_entry_line_id, entity_type, entity_id)
    SELECT
      gen_random_uuid()::varchar,
      je.organization_id,
      jel.id,
      'fixed_asset',
      jel.fixed_asset_id
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.fixed_asset_id IS NOT NULL
    ON CONFLICT (journal_entry_line_id, entity_type) DO NOTHING`;
  console.log('  fixed_asset backfill rowcount:', faResult.count);

  const afterRows = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM journal_entry_line_tags`;
  console.log('  tag rows after backfill:', afterRows[0].n);

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
