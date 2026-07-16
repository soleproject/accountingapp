/**
 * Probe: state of transactions + the unreviewed breakdown for an org.
 * Usage: npx tsx scripts/probe-acme-transactions.ts "<org name>"
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const orgName = process.argv[2] ?? 'Acme Corp';
const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

async function main() {
  const orgs = await sql<{ id: string }[]>`SELECT id FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match for "${orgName}"; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`${orgName}: ${orgId}\n`);

  const totals = await sql<{ what: string; n: number }[]>`
    SELECT 'total txns' AS what, COUNT(*)::int AS n FROM transactions WHERE organization_id = ${orgId}
    UNION ALL
    SELECT 'reviewed=true',     COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND reviewed = true
    UNION ALL
    SELECT 'reviewed=false',    COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND reviewed = false
    UNION ALL
    SELECT 'reviewed IS NULL',  COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND reviewed IS NULL
    UNION ALL
    SELECT 'categoryAccountId IS NULL', COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND category_account_id IS NULL
    UNION ALL
    SELECT 'categoryAccountId set + reviewed=false', COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND category_account_id IS NOT NULL AND reviewed = false
    UNION ALL
    SELECT 'journalEntryId IS NULL',  COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND journal_entry_id IS NULL
    UNION ALL
    SELECT 'reference LIKE plaid:%', COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND reference LIKE 'plaid:%'
    UNION ALL
    SELECT 'plaid + cat null + reviewed false/null', COUNT(*)::int FROM transactions WHERE organization_id = ${orgId} AND reference LIKE 'plaid:%' AND category_account_id IS NULL AND (reviewed = false OR reviewed IS NULL)`;

  for (const r of totals) console.log(`  ${r.what.padEnd(45)} ${r.n.toLocaleString()}`);

  // What accounts do unreviewed txns sit on?
  const catBreakdown = await sql<{ account_number: string | null; account_name: string | null; n: number }[]>`
    SELECT coa.account_number, coa.account_name, COUNT(*)::int AS n
    FROM transactions t
    LEFT JOIN chart_of_accounts coa ON coa.id = t.category_account_id
    WHERE t.organization_id = ${orgId} AND (t.reviewed = false OR t.reviewed IS NULL)
    GROUP BY coa.account_number, coa.account_name
    ORDER BY n DESC
    LIMIT 15`;
  console.log('\nunreviewed by category account (top 15):');
  for (const r of catBreakdown) {
    console.log(`  ${(r.account_number ?? '(null)').padEnd(12)} ${(r.account_name ?? '(uncategorized)').padEnd(40)} ${r.n}`);
  }

  // PFC breakdown for unreviewed
  const pfcBreakdown = await sql<{ pfc: string | null; classification: string | null; n: number }[]>`
    SELECT
      (prt.raw_json -> 'personal_finance_category' ->> 'detailed') AS pfc,
      (prt.raw_json -> 'personal_finance_category' ->> 'primary')  AS classification,
      COUNT(*)::int AS n
    FROM transactions t
    JOIN plaid_raw_transactions prt ON prt.plaid_transaction_id = REPLACE(t.reference, 'plaid:', '')
    WHERE t.organization_id = ${orgId} AND (t.reviewed = false OR t.reviewed IS NULL)
    GROUP BY pfc, classification
    ORDER BY n DESC
    LIMIT 15`;
  console.log('\nunreviewed by PFC (top 15):');
  for (const r of pfcBreakdown) console.log(`  ${(r.pfc ?? '(null)').padEnd(50)} ${r.n}`);

  // pfc_org_overrides state
  const [{ n: overrides }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM pfc_org_overrides WHERE organization_id = ${orgId}`;
  console.log(`\npfc_org_overrides rows: ${overrides}`);

  // seed visibility
  const seeds = await sql<{ is_active: boolean | null; n: number }[]>`
    SELECT is_active, COUNT(*)::int AS n FROM chart_of_accounts
    WHERE organization_id = ${orgId} AND system_generated = true
    GROUP BY is_active`;
  console.log('seed rows:');
  for (const r of seeds) console.log(`  is_active=${r.is_active}: ${r.n}`);

  await sql.end();
}

main().catch(async (err) => { console.error(err); try { await sql.end(); } catch {} process.exit(1); });
