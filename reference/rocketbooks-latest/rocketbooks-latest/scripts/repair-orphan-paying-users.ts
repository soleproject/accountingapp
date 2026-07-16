/**
 * Backfill an owned organization for every paying_user / client whose
 * users.organization_id is NULL and who doesn't already own one. Each gets a
 * placeholder workspace named "<Full Name>'s Workspace" (or email-derived
 * fallback) on the 'pro' plan. Idempotent — safe to re-run.
 *
 *   npx tsx scripts/repair-orphan-paying-users.ts
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const orphans = await sql<
    { id: string; email: string; full_name: string | null; role: string }[]
  >`
    SELECT u.id, u.email, u.full_name, u.role
    FROM users u
    WHERE u.organization_id IS NULL
      AND u.role IN ('paying_user','client')
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.owner_user_id = u.id)
  `;

  if (orphans.length === 0) {
    console.log('No orphan paying users found.');
    await sql.end();
    return;
  }

  console.log(`Found ${orphans.length} orphan paying user(s):`);
  for (const u of orphans) {
    const name = (u.full_name?.trim() || u.email.split('@')[0]);
    const workspaceName = `${name}'s Workspace`;
    const orgId = randomUUID();

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO organizations (id, name, owner_user_id, plan_type, created_at)
        VALUES (${orgId}, ${workspaceName}, ${u.id}, 'pro', NOW())
      `;
      await tx`
        UPDATE users
        SET organization_id = ${orgId}, active_organization_id = ${orgId}
        WHERE id = ${u.id}
      `;
    });

    console.log(`  - ${u.email}: created "${workspaceName}" (${orgId})`);
  }

  await sql.end();
  console.log('\nDone.');
}

main().catch(async (e) => {
  console.error('repair failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
