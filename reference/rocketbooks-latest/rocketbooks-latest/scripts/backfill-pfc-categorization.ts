/**
 * Backfill: apply the PFC → CoA mapping + reviewed-flag derivation to
 * existing transactions. Mirrors what plaid-promote.ts now does at promote
 * time, so historical rows match the new pipeline output.
 *
 * Skips:
 *   - Transactions with journal_entry_id set (posted to the GL — changing
 *     category_account_id would diverge from the journal lines).
 *   - Transactions where reviewed=true (already manually confirmed).
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/backfill-pfc-categorization.ts "1021"
 *   tsx scripts/backfill-pfc-categorization.ts "1021" --apply
 *   tsx scripts/backfill-pfc-categorization.ts <org-uuid> --apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { getPfcMapping, reviewedByDefault, type PfcMapping } from '../lib/accounting/pfc-coa-mapping';

config({ path: '.env.local' });

interface TxnRow {
  txn_id: string;
  description: string | null;
  amount: number | null;
  date: string | null;
  reference: string | null;
  category_account_id: string | null;
  reviewed: boolean | null;
  journal_entry_id: string | null;
  pfc_detailed: string | null;
}

interface CoaRow {
  id: string;
  account_type: string | null;
  detail_type: string | null;
}

interface PlannedUpdate {
  txnId: string;
  description: string | null;
  amount: number | null;
  date: string | null;
  pfcDetailed: string;
  mapping: PfcMapping;
  newCategoryAccountId: string | null;
  newCategoryLabel: string;
  newReviewed: boolean;
  source: 'primary' | 'fallback_uncategorized' | 'unmapped';
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  // By default, transactions already marked reviewed=true are skipped to
  // protect manual reviews. --include-reviewed lets a re-run re-evaluate them
  // (useful when fixing a prior auto-marking bug).
  const includeReviewed = args.includes('--include-reviewed');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/backfill-pfc-categorization.ts <org-name-or-id> [--apply]');
    process.exit(2);
  }

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

  const isUuid = /^[0-9a-f-]{36}$/i.test(target);
  const orgs = isUuid
    ? await sql<{ id: string; name: string }[]>`SELECT id, name FROM organizations WHERE id = ${target}`
    : await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM organizations WHERE name ILIKE ${'%' + target + '%'}
        ORDER BY created_at DESC LIMIT 5
      `;
  if (orgs.length === 0) { console.error(`No org matched "${target}"`); await sql.end(); process.exit(1); }
  if (orgs.length > 1) {
    console.error(`Multiple orgs matched: ${orgs.map((o) => `${o.id} ${o.name}`).join(' | ')}`);
    await sql.end(); process.exit(1);
  }
  const org = orgs[0];
  console.log(`Org: ${org.id}  ${org.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (no changes)'}\n`);

  // Pull candidate transactions joined to the raw row that holds the PFC.
  const txns = await sql<TxnRow[]>`
    SELECT
      t.id                                                     AS txn_id,
      t.description,
      t.amount,
      t.date::text                                             AS date,
      t.reference,
      t.category_account_id,
      t.reviewed,
      t.journal_entry_id,
      prt.raw_json->'personal_finance_category'->>'detailed'   AS pfc_detailed
    FROM transactions t
    LEFT JOIN plaid_raw_transactions prt
      ON prt.plaid_transaction_id = substring(t.reference FROM 7)
      AND t.reference LIKE 'plaid:%'
    WHERE t.organization_id = ${org.id}
      AND t.reference LIKE 'plaid:%'
    ORDER BY t.date DESC NULLS LAST, t.id DESC
  `;
  console.log(`Plaid-sourced transactions in this org: ${txns.length}`);

  const coa = await sql<CoaRow[]>`
    SELECT id, account_type, detail_type FROM chart_of_accounts
    WHERE organization_id = ${org.id} AND is_active = true
  `;
  const coaByPair = new Map<string, CoaRow>(
    coa.filter((c) => c.account_type && c.detail_type).map((c) => [`${c.account_type}::${c.detail_type}`, c]),
  );
  const fallbackExpense = coaByPair.get('other_expense::uncategorized_expense') ?? null;
  const fallbackIncome = coaByPair.get('other_income::uncategorized_income') ?? null;

  // Bucketing.
  const planned: PlannedUpdate[] = [];
  let skipPosted = 0;
  let skipReviewed = 0;
  let skipNoPfc = 0;
  let skipUnmapped = 0;
  let unchanged = 0;

  for (const t of txns) {
    if (t.journal_entry_id) { skipPosted++; continue; }
    if (t.reviewed === true && !includeReviewed) { skipReviewed++; continue; }
    if (!t.pfc_detailed) { skipNoPfc++; continue; }

    const mapping = getPfcMapping(t.pfc_detailed);
    if (!mapping) { skipUnmapped++; continue; }

    // Resolve to the org's CoA row.
    let coaId: string | null = null;
    let source: 'primary' | 'fallback_uncategorized' | 'unmapped' = 'unmapped';
    const primary = coaByPair.get(`${mapping.accountType}::${mapping.detailType}`);
    if (primary) { coaId = primary.id; source = 'primary'; }
    else {
      // Fallback: direction-aware uncategorized.
      const goesIncomeSide =
        mapping.classification === 'business_income' ||
        mapping.classification === 'liability_increase' ||
        (mapping.classification === 'asset_movement' && mapping.pfcPrimary === 'TRANSFER_IN') ||
        (mapping.classification === 'transfer_review' && mapping.pfcPrimary === 'TRANSFER_IN');
      const fb = goesIncomeSide ? fallbackIncome : fallbackExpense;
      if (fb) { coaId = fb.id; source = 'fallback_uncategorized'; }
    }

    // reviewed=true only when we landed on the PRIMARY canonical slot AND the
    // classification is high-confidence. Falling back to uncategorized forces
    // reviewed=false — even a confidently-classified business_expense should
    // be reviewed if its target CoA slot doesn't exist in this org.
    const newReviewed =
      coaId !== null && source === 'primary' && reviewedByDefault(mapping.classification);
    const willChange =
      t.category_account_id !== coaId || (t.reviewed ?? false) !== newReviewed;
    if (!willChange) { unchanged++; continue; }

    planned.push({
      txnId: t.txn_id,
      description: t.description,
      amount: t.amount,
      date: t.date,
      pfcDetailed: t.pfc_detailed,
      mapping,
      newCategoryAccountId: coaId,
      newCategoryLabel: source === 'primary'
        ? `${mapping.accountType}/${mapping.detailType}`
        : source === 'fallback_uncategorized'
          ? '(uncategorized fallback)'
          : '(no slot)',
      newReviewed,
      source,
    });
  }

  // Summarize the plan by classification + (account_type, detail_type) pair.
  console.log(`\n=== Plan ===`);
  console.log(`  to update              : ${planned.length}`);
  console.log(`  skipped — posted to GL : ${skipPosted}`);
  console.log(`  skipped — already reviewed: ${skipReviewed}`);
  console.log(`  skipped — no PFC on raw row: ${skipNoPfc}`);
  console.log(`  skipped — PFC not in mapping: ${skipUnmapped}`);
  console.log(`  unchanged (already correct): ${unchanged}`);

  // Group by (classification, mapping label) for readable summary.
  const byBucket = new Map<string, { count: number; reviewed: boolean; sample: PlannedUpdate }>();
  for (const p of planned) {
    const key = `${p.mapping.classification}::${p.newCategoryLabel}`;
    const existing = byBucket.get(key);
    if (existing) existing.count++;
    else byBucket.set(key, { count: 1, reviewed: p.newReviewed, sample: p });
  }
  console.log(`\n=== Update buckets (count · classification → category) ===`);
  const sorted = Array.from(byBucket.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [key, v] of sorted) {
    const reviewMark = v.reviewed ? '✓ reviewed' : '· to_review';
    console.log(`  ${String(v.count).padStart(4)}  ${reviewMark}  ${key}`);
  }

  // Sample 10 rows with their before/after.
  console.log(`\n=== Sample updates (10) ===`);
  for (const p of planned.slice(0, 10)) {
    const desc = (p.description ?? '').slice(0, 40).padEnd(40);
    const amt = p.amount === null ? '   n/a' : p.amount.toFixed(2).padStart(10);
    const flag = p.newReviewed ? '✓' : '·';
    console.log(`  ${p.date}  ${amt}  ${desc}  pfc=${p.pfcDetailed.padEnd(40)} → ${p.newCategoryLabel} ${flag}`);
  }

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  if (planned.length === 0) {
    console.log('\nNothing to update.');
    await sql.end();
    return;
  }

  console.log(`\n=== Applying ===`);
  let updated = 0;
  let failed = 0;
  // Group by (categoryAccountId, reviewed) so we can do batched UPDATEs.
  type BatchKey = string;
  const batches = new Map<BatchKey, PlannedUpdate[]>();
  for (const p of planned) {
    const key = `${p.newCategoryAccountId ?? 'NULL'}::${p.newReviewed}`;
    const list = batches.get(key) ?? [];
    list.push(p);
    batches.set(key, list);
  }
  for (const [key, group] of batches) {
    const ids = group.map((p) => p.txnId);
    const sample = group[0];
    try {
      await sql`
        UPDATE transactions
        SET category_account_id = ${sample.newCategoryAccountId},
            reviewed            = ${sample.newReviewed}
        WHERE organization_id = ${org.id}
          AND id IN ${sql(ids)}
      `;
      updated += ids.length;
      console.log(`  ✓ updated ${ids.length} rows  [${key}]`);
    } catch (err) {
      failed += ids.length;
      console.log(`  ✗ failed batch [${key}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nApplied:`);
  console.log(`  rows updated : ${updated}`);
  console.log(`  rows failed  : ${failed}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
