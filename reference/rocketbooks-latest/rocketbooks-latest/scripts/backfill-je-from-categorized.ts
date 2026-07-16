/**
 * Backfill: post a JE + GL for every transaction that has been categorized
 * (category_account_id set) but never posted (journal_entry_id null). Mirrors
 * what plaid-promote.ts now does inline — used to bring legacy rows up to
 * the new "every transaction has a JE" pipeline state.
 *
 * Skips:
 *   - Transactions with journal_entry_id already set.
 *   - Transactions missing accountId, categoryAccountId, type, or amount.
 *   - Transactions whose accountId or categoryAccountId belongs to a
 *     different org (defensive).
 *
 * Defaults to DRY-RUN. Pass --apply to commit.
 *
 * Usage:
 *   tsx scripts/backfill-je-from-categorized.ts "1021"
 *   tsx scripts/backfill-je-from-categorized.ts "1021" --apply
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

interface TxnRow {
  id: string;
  date: string | null;
  type: string | null;
  amount: number | null;
  account_id: string | null;
  category_account_id: string | null;
  contact_id: string | null;
  bank_description: string | null;
  user_description: string | null;
  description: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = positional[0];
  if (!target) {
    console.error('Usage: tsx scripts/backfill-je-from-categorized.ts <org-name-or-id> [--apply]');
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

  // Pull every transaction that's categorized but unposted.
  const txns = await sql<TxnRow[]>`
    SELECT
      id,
      date::text         AS date,
      type,
      amount,
      account_id,
      category_account_id,
      contact_id,
      bank_description,
      user_description,
      description
    FROM transactions
    WHERE organization_id = ${org.id}
      AND journal_entry_id IS NULL
      AND category_account_id IS NOT NULL
    ORDER BY date DESC NULLS LAST, id DESC
  `;
  console.log(`Categorized-but-unposted transactions: ${txns.length}`);

  // Validate accounts belong to this org. Cheap: pull all org COA ids once.
  const coaIds = new Set<string>(
    (await sql<{ id: string }[]>`
      SELECT id FROM chart_of_accounts WHERE organization_id = ${org.id}
    `).map((r) => r.id),
  );

  // Bucket each row.
  const ready: TxnRow[] = [];
  let skipNoAccount = 0;
  let skipNoCategory = 0;
  let skipNoAmount = 0;
  let skipBadType = 0;
  let skipForeignAccount = 0;

  for (const t of txns) {
    if (!t.account_id) { skipNoAccount++; continue; }
    if (!t.category_account_id) { skipNoCategory++; continue; }
    if (!t.amount || t.amount <= 0) { skipNoAmount++; continue; }
    const ttype = t.type?.toLowerCase();
    if (ttype !== 'deposit' && ttype !== 'withdrawal') { skipBadType++; continue; }
    if (!coaIds.has(t.account_id) || !coaIds.has(t.category_account_id)) {
      skipForeignAccount++;
      continue;
    }
    ready.push(t);
  }

  console.log(`\n=== Plan ===`);
  console.log(`  ready to post           : ${ready.length}`);
  console.log(`  skip — no account_id    : ${skipNoAccount}`);
  console.log(`  skip — no category      : ${skipNoCategory}`);
  console.log(`  skip — bad/zero amount  : ${skipNoAmount}`);
  console.log(`  skip — bad type         : ${skipBadType}`);
  console.log(`  skip — foreign account  : ${skipForeignAccount}`);

  // Sample of what would post.
  console.log(`\n=== Sample (10) ===`);
  for (const t of ready.slice(0, 10)) {
    const desc = (t.description ?? '').slice(0, 40).padEnd(40);
    const amt = t.amount === null ? '   n/a' : t.amount.toFixed(2).padStart(10);
    const dr = t.type === 'deposit' ? t.account_id : t.category_account_id;
    const cr = t.type === 'deposit' ? t.category_account_id : t.account_id;
    console.log(`  ${t.date}  ${t.type?.padEnd(10)}  ${amt}  ${desc}  DR ${dr?.slice(0, 8)}… / CR ${cr?.slice(0, 8)}…`);
  }

  if (!apply) {
    console.log('\nDRY-RUN — no rows changed. Re-run with --apply to commit.');
    await sql.end();
    return;
  }

  if (ready.length === 0) {
    console.log('\nNothing to post.');
    await sql.end();
    return;
  }

  console.log(`\n=== Applying ===`);
  let posted = 0;
  let failed = 0;

  for (const t of ready) {
    const ttype = t.type!.toLowerCase() as 'deposit' | 'withdrawal';
    const debitAccount = ttype === 'deposit' ? t.account_id! : t.category_account_id!;
    const creditAccount = ttype === 'deposit' ? t.category_account_id! : t.account_id!;
    const memo = t.user_description || t.bank_description || t.description || 'Transaction';
    const amt = t.amount!;
    const date = t.date!;
    const now = new Date().toISOString();
    const jeId = randomUUID();
    const drLineId = randomUUID();
    const crLineId = randomUUID();

    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO journal_entries (id, organization_id, date, memo, posted, created_at, posted_at, source_type, source_id)
          VALUES (${jeId}, ${org.id}, ${date}, ${memo}, ${true}, ${now}, ${now}, ${'transaction'}, ${t.id})
        `;
        await tx`
          INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, memo, created_at, contact_id)
          VALUES
            (${drLineId}, ${jeId}, ${debitAccount}, ${String(amt)}, ${'0'}, ${memo}, ${now}, ${t.contact_id}),
            (${crLineId}, ${jeId}, ${creditAccount}, ${'0'}, ${String(amt)}, ${memo}, ${now}, ${t.contact_id})
        `;
        await tx`
          INSERT INTO general_ledger (id, organization_id, account_id, journal_entry_id, journal_entry_line_id, contact_id, date, memo, debit, credit, balance, created_at)
          VALUES
            (${randomUUID()}, ${org.id}, ${debitAccount}, ${jeId}, ${drLineId}, ${t.contact_id}, ${date + 'T00:00:00'}, ${memo}, ${amt}, ${0}, ${null}, ${now}),
            (${randomUUID()}, ${org.id}, ${creditAccount}, ${jeId}, ${crLineId}, ${t.contact_id}, ${date + 'T00:00:00'}, ${memo}, ${0}, ${amt}, ${null}, ${now})
        `;
        await tx`UPDATE transactions SET journal_entry_id = ${jeId} WHERE id = ${t.id} AND organization_id = ${org.id}`;
      });
      posted++;
    } catch (err) {
      failed++;
      console.log(`  ✗ failed ${t.id.slice(0, 8)}…: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }

  console.log(`\nApplied:`);
  console.log(`  JEs posted (with GL pairs): ${posted}`);
  console.log(`  failed                    : ${failed}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
