/**
 * Backfill the canonical default chart of accounts onto an existing
 * organization. Idempotent: skips accounts whose accountNumber or
 * (gaap_type, detail_type) is already present.
 *
 * Defaults to DRY-RUN. Pass --apply to actually mutate.
 *
 * Usage:
 *   tsx scripts/seed-coa-for-org.ts "1021"            # dry-run by name (ILIKE)
 *   tsx scripts/seed-coa-for-org.ts "1021" --apply    # apply changes
 *   tsx scripts/seed-coa-for-org.ts <org-uuid>        # exact id match
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { DEFAULT_COA } from '../lib/accounting/default-coa-data';

config({ path: '.env.local' });

interface ExistingRow {
  id: string;
  account_number: string;
  gaap_type: string;
  detail_type: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/seed-coa-for-org.ts <org-name-or-id> [--apply]');
    process.exit(2);
  }

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

  // Resolve org. Try exact id first; fall back to ILIKE on name.
  const isUuid = /^[0-9a-f-]{36}$/i.test(target);
  const orgs = isUuid
    ? await sql<{ id: string; name: string }[]>`SELECT id, name FROM organizations WHERE id = ${target}`
    : await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM organizations
        WHERE name ILIKE ${'%' + target + '%'}
        ORDER BY created_at DESC LIMIT 5
      `;
  if (orgs.length === 0) {
    console.error(`No org matched "${target}".`);
    await sql.end();
    process.exit(1);
  }
  if (orgs.length > 1) {
    console.error(`Multiple orgs matched "${target}":`);
    for (const o of orgs) console.error(`  ${o.id}  ${o.name}`);
    console.error('Re-run with the exact id.');
    await sql.end();
    process.exit(1);
  }
  const org = orgs[0];
  console.log(`Org: ${org.id}  ${org.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}`);
  console.log('');

  // Pull existing COA rows for this org.
  const existing = await sql<ExistingRow[]>`
    SELECT id, account_number, gaap_type, detail_type
    FROM chart_of_accounts
    WHERE organization_id = ${org.id}
    ORDER BY account_number ASC
  `;
  console.log(`Existing COA rows: ${existing.length}`);
  const usedNumbers = new Set(existing.map((e) => e.account_number));
  const usedGaapDetail = new Set(
    existing.filter((e) => e.detail_type).map((e) => `${e.gaap_type}::${e.detail_type}`),
  );
  const idByNumber = new Map<string, string>(existing.map((e) => [e.account_number, e.id]));

  let willInsert = 0;
  let skipNumber = 0;
  let skipGaapDetail = 0;
  const plan: { accountNumber: string; accountName: string; reason: 'NEW' | 'SKIP_NUMBER' | 'SKIP_GAAP_DETAIL' }[] = [];

  for (const a of DEFAULT_COA) {
    if (usedNumbers.has(a.accountNumber)) {
      skipNumber++;
      plan.push({ accountNumber: a.accountNumber, accountName: a.accountName, reason: 'SKIP_NUMBER' });
      continue;
    }
    const key = `${a.gaapType}::${a.detailType}`;
    if (usedGaapDetail.has(key)) {
      skipGaapDetail++;
      plan.push({ accountNumber: a.accountNumber, accountName: a.accountName, reason: 'SKIP_GAAP_DETAIL' });
      continue;
    }
    willInsert++;
    plan.push({ accountNumber: a.accountNumber, accountName: a.accountName, reason: 'NEW' });
  }

  // Print the plan in a readable table.
  console.log('Plan:');
  for (const row of plan) {
    const marker = row.reason === 'NEW' ? '+' : '·';
    const reasonStr =
      row.reason === 'NEW'
        ? 'will insert'
        : row.reason === 'SKIP_NUMBER'
        ? 'skip — number already used'
        : 'skip — (gaap, detail) already used';
    console.log(`  ${marker} ${row.accountNumber.padEnd(5)} ${row.accountName.padEnd(40)} ${reasonStr}`);
  }
  console.log('');
  console.log(`Summary: ${willInsert} to insert · ${skipNumber} skip(number) · ${skipGaapDetail} skip(gaap+detail)`);

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  if (willInsert === 0) {
    console.log('\nNothing to insert.');
    await sql.end();
    return;
  }

  // Apply.
  let inserted = 0;
  let failed = 0;
  for (const a of DEFAULT_COA) {
    if (usedNumbers.has(a.accountNumber)) continue;
    if (usedGaapDetail.has(`${a.gaapType}::${a.detailType}`)) continue;
    const parentAccountId = a.parent ? idByNumber.get(a.parent) ?? null : null;
    const id = randomUUID();
    try {
      await sql`
        INSERT INTO chart_of_accounts (
          id, organization_id, account_number, account_name,
          gaap_type, account_type, detail_type, parent_account_id,
          normal_balance, is_active, system_generated, passed_name_contact_check
        ) VALUES (
          ${id}, ${org.id}, ${a.accountNumber}, ${a.accountName},
          ${a.gaapType}, ${a.accountType}, ${a.detailType}, ${parentAccountId},
          ${a.normalBalance}, ${true}, ${true}, ${true}
        )
      `;
      usedNumbers.add(a.accountNumber);
      usedGaapDetail.add(`${a.gaapType}::${a.detailType}`);
      idByNumber.set(a.accountNumber, id);
      inserted++;
      console.log(`  ✓ inserted ${a.accountNumber} ${a.accountName}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ failed   ${a.accountNumber} ${a.accountName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('');
  console.log(`Applied: ${inserted} inserted · ${failed} failed`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
