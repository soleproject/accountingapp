/**
 * One-off repair for a transaction left in an inconsistent state by a
 * pre-fix receipt-match cycle:
 *   - txn points at a journal_entry_id whose GL impact has been
 *     reversed (so books show $0 for the txn even though it's
 *     "categorized")
 *   - splits are still attached even though there's no active
 *     receipt-match application
 *
 * Repair:
 *   1. Delete all transaction_splits for the txn.
 *   2. If the txn has accountId + amount + type + categoryAccountId,
 *      create a fresh single-mode JE matching that state.
 *   3. Update txn.journal_entry_id → the new JE.
 *
 * Dry-run by default. Pass --apply to commit.
 *
 * Run:
 *   npx tsx scripts/repair-stranded-txn.ts <txnId>
 *   npx tsx scripts/repair-stranded-txn.ts <txnId> --apply
 */
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const apply = process.argv.includes('--apply');
  // First arg that looks like a UUID-shaped txn id.
  const txnId =
    process.argv.find((a) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a)) ?? null;
  if (!txnId) {
    console.log('Usage: npx tsx scripts/repair-stranded-txn.ts <full-txn-uuid> [--apply]');
    process.exit(1);
  }

  const { db } = await import('../db/client');
  const { transactions, transactionSplits, chartOfAccounts } = await import('../db/schema/schema');
  const { createJournalEntry } = await import('../lib/accounting/posting');

  const [txn] = await db
    .select({
      id: transactions.id,
      orgId: transactions.organizationId,
      date: transactions.date,
      amount: transactions.amount,
      type: transactions.type,
      accountId: transactions.accountId,
      categoryAccountId: transactions.categoryAccountId,
      contactId: transactions.contactId,
      userDescription: transactions.userDescription,
      bankDescription: transactions.bankDescription,
      description: transactions.description,
      journalEntryId: transactions.journalEntryId,
    })
    .from(transactions)
    .where(eq(transactions.id, txnId))
    .limit(1);
  if (!txn) { console.log(`Txn ${txnId} not found`); process.exit(0); }

  const [category] = txn.categoryAccountId
    ? await db
        .select({ name: chartOfAccounts.accountName, num: chartOfAccounts.accountNumber })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, txn.categoryAccountId))
        .limit(1)
    : [null];

  const splits = await db
    .select({ id: transactionSplits.id, amount: transactionSplits.amount, desc: transactionSplits.memo })
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, txnId));

  console.log(`Txn ${txnId.slice(0, 8)} | $${txn.amount} | ${txn.type} | category=${category ? `${category.num} ${category.name}` : '(none)'} | je=${txn.journalEntryId?.slice(0, 8) ?? 'null'}`);
  console.log(`  splits: ${splits.length}`);

  const ttype = (txn.type ?? '').toLowerCase();
  const canRebuildJe =
    txn.categoryAccountId &&
    txn.accountId &&
    txn.amount != null &&
    (ttype === 'deposit' || ttype === 'withdrawal');
  if (!canRebuildJe) {
    console.log('  ! cannot rebuild JE (missing categoryAccountId/accountId/amount/type) — only deleting splits');
  }

  console.log(apply ? '\n--- APPLYING ---' : '\n--- DRY-RUN ---');
  if (apply) {
    await db.transaction(async (tx) => {
      await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, txnId));
      console.log(`  ✓ deleted ${splits.length} split(s)`);

      if (canRebuildJe) {
        const isDeposit = ttype === 'deposit';
        const memoBase = txn.userDescription ?? txn.bankDescription ?? txn.description ?? null;
        const total = Math.abs(txn.amount!);
        const categoryLine = {
          accountId: txn.categoryAccountId!,
          debit: isDeposit ? 0 : total,
          credit: isDeposit ? total : 0,
          contactId: txn.contactId,
          memo: memoBase,
        };
        const bankLine = {
          accountId: txn.accountId!,
          debit: isDeposit ? total : 0,
          credit: isDeposit ? 0 : total,
          contactId: txn.contactId,
          memo: memoBase,
        };
        const je = await createJournalEntry(
          {
            organizationId: txn.orgId!,
            date: txn.date,
            memo: memoBase ?? `Repaired ${txn.type ?? 'transaction'}`,
            posted: true,
            sourceType: 'transaction',
            sourceId: txn.id,
            lines: isDeposit ? [bankLine, categoryLine] : [categoryLine, bankLine],
          },
          tx,
        );
        await tx.update(transactions).set({ journalEntryId: je.id }).where(eq(transactions.id, txnId));
        console.log(`  ✓ created fresh JE ${je.id.slice(0, 8)} and re-pointed txn`);
      }
    });
    console.log('Done.');
  } else {
    console.log(`  Would delete ${splits.length} split(s)`);
    if (canRebuildJe) console.log(`  Would create fresh JE for $${Math.abs(txn.amount!)} → ${category?.name}`);
    console.log('\nNo DB writes performed — re-run with --apply to commit.');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
