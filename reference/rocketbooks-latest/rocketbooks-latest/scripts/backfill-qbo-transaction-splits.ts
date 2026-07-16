/**
 * One-off: synthesize transaction_splits for QBO-promoted transactions
 * whose JE has multiple category lines but no splits rows.
 *
 * Background: the QBO promote path used to collapse multi-line purchases
 * and deposits into a single transactions row, even though the underlying
 * JE preserved every line. The detail page therefore rendered those rows
 * as single-line categorizations, hiding the real shape. Going forward
 * the promoter writes splits inline (lib/qbo/promote/promoter.ts) — this
 * fixes the historical rows.
 *
 * Run with: npx tsx scripts/backfill-qbo-transaction-splits.ts [--dry-run]
 *
 * Idempotent: only touches transactions that have a JE with >2 lines AND
 * zero existing splits.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { randomUUID } from 'crypto';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const dryRun = process.argv.includes('--dry-run');
const sql = postgres(DB_URL, { prepare: false, max: 1 });

interface Candidate {
  transactionId: string;
  organizationId: string;
  accountId: string;
  type: string;
  reference: string;
  journalEntryId: string;
  contactId: string | null;
}

interface JeLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string | null;
  contactId: string | null;
}

async function main() {
  // Candidates: QBO-origin txns with a JE, no existing splits, and a JE
  // wide enough to be a real multi-line (>2 lines = at least 1 bank + 2
  // category lines, since 2 lines is always single-category).
  const candidates: Candidate[] = await sql`
    SELECT
      t.id              AS "transactionId",
      t.organization_id AS "organizationId",
      t.account_id      AS "accountId",
      t.type            AS "type",
      t.reference       AS "reference",
      t.journal_entry_id AS "journalEntryId",
      t.contact_id      AS "contactId"
    FROM transactions t
    WHERE (t.reference LIKE 'qbo:purchase:%' OR t.reference LIKE 'qbo:deposit:%')
      AND t.journal_entry_id IS NOT NULL
      AND t.account_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id
      )
      AND (
        SELECT COUNT(*)
        FROM journal_entry_lines jel
        WHERE jel.journal_entry_id = t.journal_entry_id
      ) > 2
    ORDER BY t.date DESC`;

  console.log(`found ${candidates.length} QBO transaction(s) with a multi-line JE and no splits`);

  let inserted = 0;
  let skipped = 0;
  let problems = 0;

  for (const c of candidates) {
    const lines: JeLine[] = await sql`
      SELECT account_id AS "accountId", debit, credit, memo, contact_id AS "contactId"
      FROM journal_entry_lines
      WHERE journal_entry_id = ${c.journalEntryId}`;

    // Category lines = everything except the bank/source side of the JE.
    // Match by accountId rather than by debit/credit sign so a transaction
    // that happens to have a self-referential category (rare) still works.
    const categoryLines = lines.filter((l) => l.accountId !== c.accountId);
    if (categoryLines.length < 2) {
      // Defensive — shouldn't happen given the >2 filter, but guard anyway.
      console.warn(`  skip ${c.transactionId.slice(0, 8)} (ref=${c.reference}): only ${categoryLines.length} non-bank line(s)`);
      skipped++;
      continue;
    }

    // Aggregate by account in case the JE has multiple lines on the same
    // category account (the promoter aggregates these into one byAccount
    // entry, so we match that).
    const byAccount = new Map<string, number>();
    for (const l of categoryLines) {
      const isPurchase = c.reference.startsWith('qbo:purchase:');
      const amt = isPurchase ? Number(l.debit) : Number(l.credit);
      if (!Number.isFinite(amt) || amt <= 0) {
        problems++;
        console.warn(`  ${c.transactionId.slice(0, 8)}: non-positive line amount ${amt} on account ${l.accountId.slice(0, 8)}`);
        continue;
      }
      byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0) + amt);
    }

    if (byAccount.size < 2) {
      // All category lines collapsed to one account → not a real split.
      skipped++;
      continue;
    }

    const memo = c.reference.startsWith('qbo:purchase:') ? 'Expense' : 'Deposit source';
    const rows = Array.from(byAccount.entries()).map(([accountId, amount], idx) => ({
      id: randomUUID(),
      transaction_id: c.transactionId,
      organization_id: c.organizationId,
      category_account_id: accountId,
      amount: amount.toFixed(2),
      memo,
      contact_id: c.contactId,
      position: idx,
    }));

    console.log(`  ${c.transactionId.slice(0, 8)} (${c.reference}): ${rows.length} split rows`);

    if (!dryRun) {
      await sql.begin(async (tx) => {
        // Re-check inside the transaction in case a concurrent edit
        // created splits between our SELECT and now.
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM transaction_splits WHERE transaction_id = ${c.transactionId}`;
        if (n > 0) {
          skipped++;
          return;
        }
        for (const r of rows) {
          await tx`
            INSERT INTO transaction_splits
              (id, transaction_id, organization_id, category_account_id, amount, memo, contact_id, position)
            VALUES
              (${r.id}, ${r.transaction_id}, ${r.organization_id}, ${r.category_account_id},
               ${r.amount}, ${r.memo}, ${r.contact_id}, ${r.position})`;
        }
        inserted += rows.length;
      });
    } else {
      inserted += rows.length;
    }
  }

  console.log(`\n${dryRun ? 'DRY RUN — would insert' : 'inserted'} ${inserted} split row(s); skipped ${skipped} txn(s); ${problems} problem line(s)`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('backfill failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
