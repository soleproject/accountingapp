import { config } from 'dotenv';
import { eq, desc, and, sql } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { organizations, transactions, receipts, receiptLines, receiptMatchSuggestions, receiptMatchApplications, contacts } = await import('../db/schema/schema');

  const [acme] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, 'Acme Corp')).limit(1);
  if (!acme) { console.log('Acme not found'); process.exit(0); }
  console.log(`Acme: ${acme.id}\n`);

  const txns = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      type: transactions.type,
      accountId: transactions.accountId,
      contactId: transactions.contactId,
      je: transactions.journalEntryId,
      categoryId: transactions.categoryAccountId,
      reviewed: transactions.reviewed,
      contactName: contacts.contactName,
    })
    .from(transactions)
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(eq(transactions.organizationId, acme.id))
    .orderBy(desc(transactions.date));
  console.log(`Transactions (${txns.length}):`);
  for (const t of txns) {
    console.log(`  ${t.id.slice(0, 8)} | ${t.date} | $${t.amount} | ${t.type} | contact=${t.contactName ?? '—'} | je=${t.je?.slice(0,8) ?? '—'}`);
  }

  const recs = await db
    .select({
      id: receipts.id,
      date: receipts.receiptDate,
      amount: receipts.totalAmount,
      contactId: receipts.contactId,
      posted: receipts.posted,
      status: receipts.status,
      contactName: contacts.contactName,
    })
    .from(receipts)
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(eq(receipts.organizationId, acme.id))
    .orderBy(desc(receipts.id));
  console.log(`\nReceipts (${recs.length}):`);
  for (const r of recs) {
    console.log(`  ${r.id.slice(0, 8)} | ${r.date} | $${r.amount} | ${r.contactName ?? '—'} | posted=${r.posted}`);
    const lc = (await db.select({ n: sql<number>`count(*)::int` }).from(receiptLines).where(eq(receiptLines.receiptId, r.id)))[0]?.n ?? 0;
    console.log(`    lines: ${lc}`);

    const suggs = await db
      .select({
        id: receiptMatchSuggestions.id,
        txnId: receiptMatchSuggestions.transactionId,
        confidence: receiptMatchSuggestions.confidence,
        amountDiff: receiptMatchSuggestions.amountDiff,
        dateDiffDays: receiptMatchSuggestions.dateDiffDays,
        status: receiptMatchSuggestions.status,
      })
      .from(receiptMatchSuggestions)
      .where(eq(receiptMatchSuggestions.receiptId, r.id));
    console.log(`    suggestions: ${suggs.length}`);
    for (const s of suggs) console.log(`      → txn ${s.txnId.slice(0, 8)} | conf=${s.confidence} | Δ=${s.amountDiff} | days=${s.dateDiffDays} | ${s.status}`);

    const apps = await db
      .select({ id: receiptMatchApplications.id, reversedAt: receiptMatchApplications.reversedAt })
      .from(receiptMatchApplications)
      .where(eq(receiptMatchApplications.receiptId, r.id));
    console.log(`    applications: ${apps.length}`);
    for (const a of apps) console.log(`      app ${a.id.slice(0, 8)} reversed=${a.reversedAt ?? 'no'}`);
  }

  process.exit(0);
}
main().catch(console.error);
