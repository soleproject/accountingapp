/**
 * One-off: apply migration 0048_user_tag_dimensions.sql.
 * Run with: npx tsx scripts/apply-0048-user-tag-dimensions.ts
 *
 * Idempotent — uses IF NOT EXISTS on schema objects.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS tag_dimensions (
      id varchar PRIMARY KEY,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      slug varchar NOT NULL,
      label varchar NOT NULL,
      emoji varchar(8),
      sort_order integer DEFAULT 0 NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT tag_dimensions_org_slug_unique UNIQUE (organization_id, slug)
    )`;
  console.log('  tag_dimensions table ok');
  await sql`CREATE INDEX IF NOT EXISTS ix_tag_dimensions_org_id ON tag_dimensions (organization_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS tag_dimension_values (
      id varchar PRIMARY KEY,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      dimension_id varchar NOT NULL REFERENCES tag_dimensions(id) ON DELETE CASCADE,
      label varchar NOT NULL,
      sort_order integer DEFAULT 0 NOT NULL,
      archived_at timestamptz,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      CONSTRAINT tag_dimension_values_dim_label_unique UNIQUE (dimension_id, label)
    )`;
  console.log('  tag_dimension_values table ok');
  await sql`CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_org_id ON tag_dimension_values (organization_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_dim_id ON tag_dimension_values (dimension_id)`;
  await sql`
    CREATE INDEX IF NOT EXISTS ix_tag_dimension_values_active
      ON tag_dimension_values (dimension_id)
      WHERE archived_at IS NULL`;

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
