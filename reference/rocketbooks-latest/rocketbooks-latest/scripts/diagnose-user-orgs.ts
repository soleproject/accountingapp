/**
 * Dumps everything we'd consult to decide a user's "primary org".
 *   npx tsx scripts/diagnose-user-orgs.ts <userId>
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const userId = process.argv[2];
if (!userId) {
  console.error('usage: npx tsx scripts/diagnose-user-orgs.ts <userId>');
  process.exit(1);
}

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const u = await sql`SELECT id, email, full_name, role, organization_id, active_organization_id, is_active, created_at FROM users WHERE id = ${userId} LIMIT 1`;
  console.log('\nusers row:');
  console.log(u[0] ?? '(none)');

  const owned = await sql`SELECT id, name, plan_type, created_at FROM organizations WHERE owner_user_id = ${userId}`;
  console.log(`\nowned organizations (${owned.length}):`);
  for (const r of owned) console.log(' ', r.id, r.name, `[${r.plan_type}]`);

  const staff = await sql`SELECT es.id, es.role, es.enterprise_id, o.name FROM enterprise_staff es LEFT JOIN organizations o ON o.id = es.enterprise_id WHERE es.staff_user_id = ${userId}`;
  console.log(`\nenterprise_staff (${staff.length}):`);
  for (const r of staff) console.log(' ', r.id, 'role=' + r.role, 'enterprise=' + r.enterprise_id, '(' + r.name + ')');

  const clients = await sql`SELECT ec.id, ec.status, ec.enterprise_id, o.name FROM enterprise_clients ec LEFT JOIN organizations o ON o.id = ec.enterprise_id WHERE ec.client_user_id = ${userId}`;
  console.log(`\nenterprise_clients (${clients.length}):`);
  for (const r of clients) console.log(' ', r.id, 'status=' + r.status, 'enterprise=' + r.enterprise_id, '(' + r.name + ')');

  const support = await sql`SELECT osu.id, osu.status, osu.organization_id, o.name FROM organization_support_users osu LEFT JOIN organizations o ON o.id = osu.organization_id WHERE osu.support_user_id = ${userId}`;
  console.log(`\norganization_support_users (${support.length}):`);
  for (const r of support) console.log(' ', r.id, 'status=' + r.status, 'org=' + r.organization_id, '(' + r.name + ')');

  await sql.end();
}

main().catch(async (e) => {
  console.error('diagnose failed:', e);
  try { await sql.end(); } catch { /* noop */ }
  process.exit(1);
});
