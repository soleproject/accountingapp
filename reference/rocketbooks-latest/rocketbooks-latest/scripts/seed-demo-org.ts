/**
 * Seeds the demo system user and the demo org. Idempotent — safe to re-run.
 *
 *   npx tsx scripts/seed-demo-org.ts
 *
 * The demo org is intentionally minimal (no transactions, no contacts). The
 * app renders empty-state UIs cleanly. Fixtures can be layered in later via
 * direct SQL — DO NOT use Plaid/Veryfi ingestion paths for demo data.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

// Mirrors lib/auth/demo.ts constants. Keep both in sync.
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000000';
const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_SYSTEM_EMAIL = 'demo-system@rocketsuite.local';

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  // 1. Ensure the demo system user exists.
  const existingUser = await sql<{ id: string }[]>`SELECT id FROM users WHERE id = ${DEMO_USER_ID} LIMIT 1`;
  if (existingUser.length === 0) {
    await sql`
      INSERT INTO users (id, email, password_hash, full_name, is_active, role, created_at, updated_at)
      VALUES (${DEMO_USER_ID}, ${DEMO_SYSTEM_EMAIL}, 'supabase', 'Demo System', true, 'demo_system', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`created demo system user (${DEMO_USER_ID})`);
  } else {
    console.log(`exists  demo system user (${DEMO_USER_ID})`);
  }

  // 2. Ensure the demo org exists.
  const existingOrg = await sql<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${DEMO_ORG_ID} LIMIT 1`;
  if (existingOrg.length === 0) {
    await sql`
      INSERT INTO organizations (id, name, owner_user_id, plan_type, created_at)
      VALUES (${DEMO_ORG_ID}, 'Demo Workspace', ${DEMO_USER_ID}, 'demo', NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`created demo org      (${DEMO_ORG_ID})`);
  } else {
    console.log(`exists  demo org      (${DEMO_ORG_ID})`);
  }

  await sql.end();
  console.log('\nDone.');
}

main().catch(async (e) => {
  console.error('seed-demo-org failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
