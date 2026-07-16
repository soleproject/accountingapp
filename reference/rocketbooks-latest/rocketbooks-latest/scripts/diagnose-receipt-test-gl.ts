import { config } from 'dotenv';
import { eq, and, desc } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const { db } = await import('../db/client');
  const { journalEntries, journalEntryLines, transactions, chartOfAccounts, organizations, generalLedger } = await import('../db/schema/schema');

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Receipt Test Co, LLC'))
    .limit(1);
  if (!org) { console.log('Org not found'); process.exit(0); }

  // Current txns + their JE
  const txns = await db
    .select({ id: transactions.id, je: transactions.journalEntryId, cat: transactions.categoryAccountId, desc: transactions.description, amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.organizationId, org.id));
  console.log(`Txns: ${txns.length}`);
  for (const t of txns) {
    console.log(`  ${t.id.slice(0, 8)} | $${t.amount} | je=${t.je?.slice(0, 8) ?? 'NULL'} | cat=${t.cat?.slice(0, 8) ?? 'NULL'}`);
  }

  // All JEs with their reversal status
  const jes = await db
    .select({ id: journalEntries.id, date: journalEntries.date, sourceType: journalEntries.sourceType, sourceId: journalEntries.sourceId, reversalOfId: journalEntries.reversalOfId, memo: journalEntries.memo })
    .from(journalEntries)
    .where(eq(journalEntries.organizationId, org.id))
    .orderBy(desc(journalEntries.createdAt));

  // Find reversers
  const reversedBy = new Map<string, string>(); // original id → reverser id
  for (const j of jes) if (j.reversalOfId) reversedBy.set(j.reversalOfId, j.id);

  console.log(`\nJEs: ${jes.length} | active (not reversed, not a reversal): ${jes.filter((j) => !j.reversalOfId && !reversedBy.has(j.id)).length}`);
  for (const j of jes) {
    const isReversal = !!j.reversalOfId;
    const isReversed = reversedBy.has(j.id);
    const state = isReversal ? 'REVERSAL' : isReversed ? 'REVERSED' : 'ACTIVE';
    console.log(`  ${j.id.slice(0, 8)} | ${state} | source=${j.sourceType}/${j.sourceId?.slice(0, 8) ?? '-'} | "${j.memo}"`);
  }

  // Active JEs — pull their lines
  console.log(`\nLines on ACTIVE JEs (net GL contribution):`);
  for (const j of jes) {
    if (j.reversalOfId || reversedBy.has(j.id)) continue;
    const lines = await db
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit, name: chartOfAccounts.accountName, num: chartOfAccounts.accountNumber, memo: journalEntryLines.memo })
      .from(journalEntryLines)
      .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
      .where(eq(journalEntryLines.journalEntryId, j.id));
    console.log(`  JE ${j.id.slice(0, 8)} (${lines.length} lines):`);
    for (const l of lines) console.log(`    ${l.num} ${l.name} | D=${l.debit} C=${l.credit} | "${l.memo}"`);
  }

  // GL aggregate per account
  const glRows = await db
    .select({ name: chartOfAccounts.accountName, num: chartOfAccounts.accountNumber, debit: generalLedger.debit, credit: generalLedger.credit, jeId: generalLedger.journalEntryId, date: generalLedger.date })
    .from(generalLedger)
    .leftJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
    .where(eq(generalLedger.organizationId, org.id));
  console.log(`\nGL rows (${glRows.length}) per account:`);
  const byAccount = new Map<string, { debit: number; credit: number; count: number }>();
  for (const r of glRows) {
    const k = `${r.num} ${r.name}`;
    const cur = byAccount.get(k) ?? { debit: 0, credit: 0, count: 0 };
    cur.debit += Number(r.debit);
    cur.credit += Number(r.credit);
    cur.count += 1;
    byAccount.set(k, cur);
  }
  for (const [k, v] of byAccount) {
    const net = v.debit - v.credit;
    console.log(`  ${k}: ${v.count} rows | D=$${v.debit.toFixed(2)} C=$${v.credit.toFixed(2)} NET=$${net.toFixed(2)}`);
  }
  process.exit(0);
}
main().catch(console.error);
