/**
 * Inspect the actual state of the Walmart-linked txn in Receipt Test Co
 * to figure out why the drill-down shows it.
 */
import { config } from 'dotenv';
import { eq, and, isNotNull } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { transactions, organizations, journalEntries, journalEntryLines, chartOfAccounts, transactionSplits } = await import('../db/schema/schema');

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.name, 'Receipt Test Co, LLC'))
    .limit(1);
  if (!org) { console.log('Org not found'); process.exit(0); }
  console.log(`Org: ${org.name} (${org.id})`);

  const txns = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      accountId: transactions.accountId,
      categoryAccountId: transactions.categoryAccountId,
      journalEntryId: transactions.journalEntryId,
      description: transactions.description,
    })
    .from(transactions)
    .where(eq(transactions.organizationId, org.id));

  console.log(`\nTxns in org: ${txns.length}`);
  for (const t of txns) {
    console.log(`  ${t.id.slice(0, 8)} | ${t.date} | $${t.amount} | accountId=${t.accountId?.slice(0, 8) ?? 'NONE'} | categoryAccountId=${t.categoryAccountId?.slice(0, 8) ?? 'NULL'} | je=${t.journalEntryId?.slice(0, 8) ?? 'NULL'}`);

    if (t.journalEntryId) {
      const [je] = await db
        .select({
          id: journalEntries.id,
          sourceType: journalEntries.sourceType,
          reversalOfId: journalEntries.reversalOfId,
          memo: journalEntries.memo,
        })
        .from(journalEntries)
        .where(eq(journalEntries.id, t.journalEntryId))
        .limit(1);
      console.log(`    je: sourceType=${je?.sourceType} reversalOf=${je?.reversalOfId?.slice(0, 8) ?? 'NULL'} memo="${je?.memo}"`);

      const lines = await db
        .select({
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          accountId: journalEntryLines.accountId,
          accountName: chartOfAccounts.accountName,
          accountNumber: chartOfAccounts.accountNumber,
          memo: journalEntryLines.memo,
        })
        .from(journalEntryLines)
        .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
        .where(eq(journalEntryLines.journalEntryId, t.journalEntryId));
      console.log(`    je lines (${lines.length}):`);
      for (const l of lines) {
        console.log(`      ${l.accountNumber} ${l.accountName} | debit=${l.debit} credit=${l.credit} | memo="${l.memo}"`);
      }
    }

    const splits = await db
      .select({
        accountId: transactionSplits.categoryAccountId,
        accountName: chartOfAccounts.accountName,
        amount: transactionSplits.amount,
        memo: transactionSplits.memo,
        intent: transactionSplits.intent,
      })
      .from(transactionSplits)
      .leftJoin(chartOfAccounts, eq(transactionSplits.categoryAccountId, chartOfAccounts.id))
      .where(eq(transactionSplits.transactionId, t.id));
    if (splits.length > 0) {
      console.log(`    splits (${splits.length}):`);
      for (const s of splits) console.log(`      ${s.accountName} | $${s.amount} | "${s.memo}" | intent=${s.intent}`);
    }
  }

  // Also dump all JEs in this org to find reversals + leaked entries
  const allJes = await db
    .select({
      id: journalEntries.id,
      date: journalEntries.date,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      reversalOfId: journalEntries.reversalOfId,
      memo: journalEntries.memo,
    })
    .from(journalEntries)
    .where(eq(journalEntries.organizationId, org.id));
  console.log(`\nAll JEs in org: ${allJes.length}`);
  for (const j of allJes) {
    console.log(`  ${j.id.slice(0, 8)} | ${j.date} | source=${j.sourceType}/${j.sourceId?.slice(0, 8) ?? 'null'} | reversalOf=${j.reversalOfId?.slice(0, 8) ?? '-'} | "${j.memo}"`);
  }

  process.exit(0);
}
main().catch(console.error);
