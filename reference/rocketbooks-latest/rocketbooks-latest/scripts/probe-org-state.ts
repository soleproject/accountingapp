/**
 * Print the current state of an org across QB, Plaid, CoA, and PFC tables.
 * Read-only — useful before deciding how to reset.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/probe-org-state.ts "<org name>"');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgs[0].name} (id=${orgId})\n`);

  const counts: Array<[string, number]> = [];
  const push = (label: string, rows: { n: number }[]) => counts.push([label, rows[0]?.n ?? 0]);

  push('chart_of_accounts (system_generated=true, active)', await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${orgId} AND system_generated = true AND is_active = true`);
  push('chart_of_accounts (system_generated=true, inactive)', await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${orgId} AND system_generated = true AND is_active = false`);
  push('chart_of_accounts (system_generated=false)', await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${orgId} AND (system_generated IS NULL OR system_generated = false)`);
  push('pfc_org_overrides', await sql`SELECT COUNT(*)::int n FROM pfc_org_overrides WHERE organization_id = ${orgId}`);
  push('qbo_connections', await sql`SELECT COUNT(*)::int n FROM qbo_connections WHERE org_id = ${orgId}`);
  push('qbo_migration_jobs', await sql`SELECT COUNT(*)::int n FROM qbo_migration_jobs WHERE org_id = ${orgId}`);
  push('qbo_entity_map', await sql`SELECT COUNT(*)::int n FROM qbo_entity_map WHERE organization_id = ${orgId}`);
  push('qbo_conflicts', await sql`SELECT COUNT(*)::int n FROM qbo_conflicts WHERE organization_id = ${orgId}`);
  push('qbo_outbound_queue', await sql`SELECT COUNT(*)::int n FROM qbo_outbound_queue WHERE organization_id = ${orgId}`);
  push('qbo_mirror_settings', await sql`SELECT COUNT(*)::int n FROM qbo_mirror_settings WHERE organization_id = ${orgId}`);
  push('qbo_account_staging (via job)', await sql`SELECT COUNT(*)::int n FROM qbo_account_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${orgId}`);
  push('contacts', await sql`SELECT COUNT(*)::int n FROM contacts WHERE organization_id = ${orgId}`);
  push('plaid_accounts (via linked org)', await sql`SELECT COUNT(*)::int n FROM plaid_accounts WHERE linked_organization_id = ${orgId}`);
  push('transactions', await sql`SELECT COUNT(*)::int n FROM transactions WHERE organization_id = ${orgId}`);
  push('journal_entries', await sql`SELECT COUNT(*)::int n FROM journal_entries WHERE organization_id = ${orgId}`);

  for (const [label, n] of counts) {
    console.log(`  ${label.padEnd(50)} ${n.toLocaleString()}`);
  }
  await sql.end();
}

main().catch(async (err) => {
  console.error('probe failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
