/**
 * One-off: apply migration 0010_org_contact_fields.sql.
 * Run with: npx tsx scripts/apply-org-contact-fields.ts
 *
 * Idempotent — only adds the columns if they're missing. Safe to re-run.
 */
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  await db.execute(sql.raw(`
    ALTER TABLE public.organizations
      ADD COLUMN IF NOT EXISTS address jsonb,
      ADD COLUMN IF NOT EXISTS website varchar,
      ADD COLUMN IF NOT EXISTS phone varchar,
      ADD COLUMN IF NOT EXISTS fax varchar,
      ADD COLUMN IF NOT EXISTS email varchar;
  `));
  console.log('✓ organizations: address, website, phone, fax, email columns ensured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ migration failed:', err);
  process.exit(1);
});
