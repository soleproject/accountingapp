/**
 * Diagnostic for the finalizeCoa phase.
 * Run with: npx tsx scripts/diagnose-qbo-finalize.ts "QBO Test 5, LLC"
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/diagnose-qbo-finalize.ts "<org name>"');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length === 0) {
    console.log(`no org found with name "${orgName}". Trying ILIKE…`);
    const fuzzy = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations WHERE name ILIKE ${'%' + orgName + '%'}`;
    if (fuzzy.length === 0) throw new Error('no match');
    console.log('fuzzy matches:', fuzzy);
    return;
  }
  if (orgs.length > 1) {
    console.log('multiple matches:', orgs);
    throw new Error('disambiguate');
  }
  const orgId = orgs[0].id;
  console.log(`org: ${orgs[0].name} (id=${orgId})\n`);

  // 1. Latest migration job + report
  const jobs = await sql<{
    id: string;
    status: string;
    progress: number | null;
    completed_at: string | null;
    error_message: string | null;
    migration_report: Record<string, unknown> | null;
  }[]>`
    SELECT id, status, progress, completed_at, error_message, migration_report
    FROM qbo_migration_jobs
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT 3`;
  console.log(`latest migration jobs (${jobs.length}):`);
  for (const j of jobs) {
    console.log(`  ${j.id.slice(0, 8)} status=${j.status} progress=${j.progress}% completed=${j.completed_at ?? '(running)'}`);
    if (j.error_message) console.log(`    error: ${j.error_message}`);
    const report = j.migration_report as { promote?: Record<string, unknown>; entities?: Record<string, unknown> } | null;
    if (report?.promote) {
      console.log(`    promote phases:`);
      for (const [phase, summary] of Object.entries(report.promote)) {
        console.log(`      ${phase}:`, summary);
      }
    } else {
      console.log(`    no promote summary in report`);
    }
  }

  // 2. pfc_org_overrides count + breakdown
  console.log(`\npfc_org_overrides for this org:`);
  const overrideCount = await sql<{ source: string; n: number }[]>`
    SELECT source, COUNT(*)::int AS n
    FROM pfc_org_overrides
    WHERE organization_id = ${orgId}
    GROUP BY source ORDER BY source`;
  if (overrideCount.length === 0) {
    console.log('  (none — finalize never wrote anything)');
  } else {
    for (const r of overrideCount) console.log(`  ${r.source}: ${r.n}`);
  }

  // 3. seed row visibility
  console.log(`\nseed rows for this org:`);
  const seedBreakdown = await sql<{ is_active: boolean | null; n: number }[]>`
    SELECT is_active, COUNT(*)::int AS n
    FROM chart_of_accounts
    WHERE organization_id = ${orgId} AND system_generated = true
    GROUP BY is_active ORDER BY is_active`;
  for (const r of seedBreakdown) console.log(`  is_active=${r.is_active}: ${r.n}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('diagnose failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
