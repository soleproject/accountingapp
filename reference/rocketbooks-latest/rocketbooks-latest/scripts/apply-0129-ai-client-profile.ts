/**
 * One-off: apply migration 0129_org_ai_client_profile.sql.
 * Run with: npx tsx scripts/apply-0129-ai-client-profile.ts
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS is a no-op when the column already
 * exists. Nullable jsonb, no backfill, no table rewrite/lock.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  await sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ai_client_profile jsonb`;
  const present = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'ai_client_profile'`;
  console.log('ai_client_profile column:', present[0]?.data_type ?? 'MISSING');
  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
