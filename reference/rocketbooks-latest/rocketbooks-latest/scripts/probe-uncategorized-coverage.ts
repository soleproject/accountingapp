/**
 * For each pfc_org_override pointing at Uncategorized in an org, show:
 *   - The PFC code + description + classification
 *   - The PFC's canonical (accountType, detailType) slot
 *   - All QB-imported CoA rows in that exact slot
 *   - All QB-imported CoA rows in the same gaap_type (broader candidates)
 *
 * Tells us whether the AI mapper missed available QB accounts (re-map),
 * or whether QB genuinely lacks a match (seed reactivation).
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/probe-uncategorized-coverage.ts "<org name>"');

async function main() {
  const orgs = await sql<{ id: string }[]>`
    SELECT id FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgName} (${orgId})\n`);

  const orphans = await sql<{ pfcDetailed: string; oldCoaId: string; oldName: string }[]>`
    SELECT
      o.pfc_detailed AS "pfcDetailed",
      coa.id AS "oldCoaId",
      coa.account_name AS "oldName"
    FROM pfc_org_overrides o
    JOIN chart_of_accounts coa ON coa.id = o.category_account_id
    WHERE o.organization_id = ${orgId}
      AND (coa.account_name ~* 'uncategori[sz]ed' OR coa.detail_type ~* '^uncategori[sz]ed')
    ORDER BY o.pfc_detailed`;

  console.log(`overrides pointing at Uncategorized: ${orphans.length}\n`);
  await sql.end();

  const { PFC_COA_MAPPINGS, getPfcMapping } = await import('@/lib/accounting/pfc-coa-mapping');
  const { db } = await import('@/db/client');
  const { chartOfAccounts } = await import('@/db/schema/schema');
  const { and, eq } = await import('drizzle-orm');
  void PFC_COA_MAPPINGS;

  // Group by canonical slot so we only need one lookup per unique slot
  const bySlot = new Map<string, { accountType: string; detailType: string; gaap: string; pfcs: typeof orphans }>();
  for (const o of orphans) {
    const m = getPfcMapping(o.pfcDetailed);
    if (!m) {
      console.log(`UNMAPPED PFC: ${o.pfcDetailed}`);
      continue;
    }
    // Derive gaap from accountType — we don't have it directly on mapping,
    // but we can infer from the PFC mapping conventions.
    const gaap = m.accountType.startsWith('income') || m.accountType === 'other_income' ? 'income'
      : m.accountType === 'equity' ? 'equity'
      : m.accountType.includes('liab') ? 'liability'
      : (m.accountType === 'bank' || m.accountType.includes('asset')) ? 'asset'
      : 'expense';
    const key = `${m.accountType}|${m.detailType}`;
    const entry = bySlot.get(key) ?? { accountType: m.accountType, detailType: m.detailType, gaap, pfcs: [] };
    entry.pfcs.push(o);
    bySlot.set(key, entry);
  }

  const slots = Array.from(bySlot.values()).sort((a, b) => b.pfcs.length - a.pfcs.length);
  console.log(`unique canonical slots affected: ${slots.length}\n`);
  console.log('═'.repeat(110));

  let totalQbMatches = 0;
  let totalNoMatch = 0;

  for (const slot of slots) {
    // Find all CoA rows in this exact slot, regardless of isActive
    const exact = await db
      .select({
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        isActive: chartOfAccounts.isActive,
        systemGenerated: chartOfAccounts.systemGenerated,
      })
      .from(chartOfAccounts)
      .where(and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.accountType, slot.accountType),
        eq(chartOfAccounts.detailType, slot.detailType),
      ));

    const qbMatches = exact.filter((c) => c.systemGenerated !== true);
    const seedMatches = exact.filter((c) => c.systemGenerated === true);
    const hasQb = qbMatches.length > 0;
    if (hasQb) totalQbMatches += slot.pfcs.length;
    else totalNoMatch += slot.pfcs.length;

    const status = hasQb ? '✅ QB MATCH AVAILABLE (AI missed)' : (seedMatches.length > 0 ? '🌱 SEED ONLY (needs reactivation)' : '❌ NO MATCH AT ALL');
    console.log(`\n[${status}]  slot: ${slot.accountType} / ${slot.detailType}`);
    console.log(`  PFCs affected (${slot.pfcs.length}): ${slot.pfcs.slice(0, 4).map((p) => p.pfcDetailed).join(', ')}${slot.pfcs.length > 4 ? '…' : ''}`);
    if (qbMatches.length > 0) {
      console.log(`  QB rows in this slot:`);
      for (const c of qbMatches) console.log(`    ${c.accountNumber.padEnd(10)} ${c.accountName} ${c.isActive === false ? '(hidden)' : ''}`);
    }
    if (seedMatches.length > 0) {
      console.log(`  Seed rows in this slot:`);
      for (const c of seedMatches) console.log(`    ${c.accountNumber.padEnd(10)} ${c.accountName} ${c.isActive === false ? '(hidden)' : ''}`);
    }
    if (exact.length === 0) {
      console.log(`  (no rows at all in this slot)`);
    }
  }

  console.log('\n' + '═'.repeat(110));
  console.log(`\nsummary:`);
  console.log(`  PFCs where QB has an available match the AI missed: ${totalQbMatches}`);
  console.log(`  PFCs where only the seed has the slot (needs reactivation): ${totalNoMatch - slots.filter((s) => false).length}`);
  console.log(`  → If most are "QB MATCH AVAILABLE", we should re-run AI mapping with a better prompt.`);
  console.log(`  → If most are "SEED ONLY", reactivate the seeds.`);
}

main().catch(async (err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
