/**
 * Diagnostic: dump recent receipts + transactions per org, see what
 * the matcher would actually match.
 *
 * Run: npx tsx scripts/diagnose-receipt-match.ts
 */
import { config } from 'dotenv';
import { desc, eq, and, gte, lte, sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { receipts, transactions, receiptMatchSuggestions, contacts, organizations } = await import(
    '../db/schema/schema'
  );

  // List 5 most recent receipts globally, with org name + vendor.
  const recent = await db
    .select({
      id: receipts.id,
      orgId: receipts.organizationId,
      orgName: organizations.name,
      receiptDate: receipts.receiptDate,
      totalAmount: receipts.totalAmount,
      contactName: contacts.contactName,
    })
    .from(receipts)
    .leftJoin(organizations, eq(receipts.organizationId, organizations.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .orderBy(desc(receipts.id))
    .limit(8);

  console.log('Recent receipts:');
  for (const r of recent) {
    console.log(`  ${r.id.slice(0, 8)} | org=${r.orgName ?? r.orgId.slice(0, 8)} | date=${r.receiptDate} | $${r.totalAmount} | vendor=${r.contactName ?? '—'}`);
  }

  // Pick the Walmart $88 receipt — that's the one in the screenshot.
  const target = recent.find((r) => r.totalAmount === 88 && r.contactName === 'Walmart');
  if (!target) {
    console.log('\nNo Walmart $88 receipt found in last 8 receipts.');
    process.exit(0);
  }

  console.log(`\nFocusing on: ${target.id.slice(0, 8)} (org ${target.orgName})`);

  const center = new Date(target.receiptDate!);
  const from = new Date(center.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(center.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);

  console.log(`Window: ${from} → ${to}`);

  const wideRows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      description: transactions.description,
      contactId: transactions.contactId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, target.orgId),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .orderBy(desc(transactions.date));

  console.log(`\nAll txns in window for this org (both signs): ${wideRows.length}`);
  for (const t of wideRows.slice(0, 20)) {
    const sign = t.amount == null ? '?' : t.amount < 0 ? 'NEG' : t.amount > 0 ? 'POS' : 'ZERO';
    const absDiff = t.amount == null ? null : Math.abs(Math.abs(t.amount) - target.totalAmount);
    console.log(`  ${t.id.slice(0, 8)} | ${t.date} | amount=${t.amount} (${sign}) | |Δ|=${absDiff?.toFixed(2)} | ${t.description ?? '—'}`);
  }

  const matcherRows = await db
    .select({ id: transactions.id, amount: transactions.amount, date: transactions.date })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, target.orgId),
        sql`${transactions.amount} < 0`,
        sql`ABS(ABS(${transactions.amount}) - ${target.totalAmount}) <= 0.5`,
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    );

  console.log(`\nMatcher SQL hits (amount<0 + |Δ|≤0.50): ${matcherRows.length}`);

  // Also try the OTHER sign in case convention is flipped.
  const flippedRows = await db
    .select({ id: transactions.id, amount: transactions.amount, date: transactions.date })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, target.orgId),
        sql`${transactions.amount} > 0`,
        sql`ABS(${transactions.amount} - ${target.totalAmount}) <= 0.5`,
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    );
  console.log(`Flipped-sign check (amount>0 + |Δ|≤0.50): ${flippedRows.length}`);
  for (const t of flippedRows) console.log(`  ${t.id.slice(0, 8)} | ${t.date} | amount=${t.amount}`);

  const persisted = await db
    .select({ transactionId: receiptMatchSuggestions.transactionId, confidence: receiptMatchSuggestions.confidence })
    .from(receiptMatchSuggestions)
    .where(eq(receiptMatchSuggestions.receiptId, target.id));

  console.log(`\nPersisted suggestions for this receipt: ${persisted.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
