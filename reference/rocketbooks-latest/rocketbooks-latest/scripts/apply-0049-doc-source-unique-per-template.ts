/**
 * One-off: apply migration 0049_document_records_source_unique_per_template.sql.
 * Run with: npx tsx scripts/apply-0049-doc-source-unique-per-template.ts
 *
 * Idempotent — DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  await sql`DROP INDEX IF EXISTS ix_document_records_auto_source_unique`;
  console.log('  dropped old (org, source_kind, source_id) index');

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ix_document_records_auto_source_unique
      ON document_records (organization_id, source_kind, source_id, template_id)
      WHERE source_kind IS NOT NULL
        AND source_kind <> 'manual'
        AND status <> 'voided'`;
  console.log('  created new (org, source_kind, source_id, template_id) index');

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
