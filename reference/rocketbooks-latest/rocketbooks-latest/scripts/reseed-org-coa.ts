/**
 * Delete every chart_of_accounts row for an org and re-run seedDefaultCoa
 * to get a clean 51-row seed. Use after reset-org-for-testing.ts when the
 * existing seed is partial/stale.
 *
 * Safety: refuses to run if there are any rows in chart_of_accounts that
 * other tables still reference (transactions/JEs/etc.) — those need to
 * be cleared first so we don't violate the NO ACTION FK constraints.
 *
 * Usage:
 *   npx tsx scripts/reseed-org-coa.ts "Acme Corp"
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/reseed-org-coa.ts "<org name>"');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match for "${orgName}"; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`org: ${orgs[0].name} (id=${orgId})`);

  // Safety: bail if anything still references CoA rows for this org. The
  // reset-org-for-testing.ts script clears the usual suspects; this catches
  // a footgun where someone runs reseed without resetting first.
  const refs = await sql<{ table_name: string; n: number }[]>`
    SELECT 'transactions' AS table_name, COUNT(*)::int AS n FROM transactions WHERE category_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${orgId})
    UNION ALL
    SELECT 'transaction_splits', COUNT(*)::int FROM transaction_splits WHERE category_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${orgId})
    UNION ALL
    SELECT 'journal_entry_lines', COUNT(*)::int FROM journal_entry_lines WHERE account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${orgId})
    UNION ALL
    SELECT 'invoices', COUNT(*)::int FROM invoices WHERE ar_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${orgId})
    UNION ALL
    SELECT 'plaid_accounts', COUNT(*)::int FROM plaid_accounts WHERE chart_of_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${orgId})
    UNION ALL
    SELECT 'pfc_org_overrides', COUNT(*)::int FROM pfc_org_overrides WHERE organization_id = ${orgId}`;
  const refTotal = refs.reduce((s, r) => s + r.n, 0);
  if (refTotal > 0) {
    console.log('\nrefuses to delete CoA — these tables still reference rows:');
    for (const r of refs) if (r.n > 0) console.log(`  ${r.table_name}: ${r.n}`);
    console.log('\nrun reset-org-for-testing.ts first.');
    throw new Error('CoA still referenced; aborting');
  }

  const before = await sql<{ n: number }[]>`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${orgId}`;
  console.log(`\ndeleting ${before[0].n} existing chart_of_accounts row(s)…`);

  await sql.begin(async (tx) => {
    // Null self-FKs so the delete order doesn't matter.
    await tx`UPDATE chart_of_accounts SET parent_account_id = NULL, suggested_match_coa_id = NULL WHERE organization_id = ${orgId}`;
    await tx`DELETE FROM chart_of_accounts WHERE organization_id = ${orgId}`;
  });
  console.log('  done.');

  await sql.end();

  // Dynamic import — server-only module loads after dotenv runs.
  const { seedDefaultCoa } = await import('@/lib/accounting/seed-default-coa');

  console.log('\nreseeding…');
  const result = await seedDefaultCoa({ organizationId: orgId });
  console.log('  result:', result);
}

main().catch((err) => {
  console.error('reseed failed:', err);
  process.exit(1);
});
