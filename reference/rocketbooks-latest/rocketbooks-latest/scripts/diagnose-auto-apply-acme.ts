/**
 * Check why auto-apply did/didn't fire for the Acme Corp Walmart match.
 * Run: npx tsx scripts/diagnose-auto-apply-acme.ts
 */
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const {
    organizations,
    receipts,
    receiptLines,
    receiptMatchSuggestions,
    receiptMatchApplications,
    transactions,
    contacts,
  } = await import('../db/schema/schema');

  const [acme] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.name, 'Acme Corp'))
    .limit(1);
  if (!acme) {
    console.log('Acme Corp not found.');
    process.exit(0);
  }
  console.log(`Acme Corp org id: ${acme.id}`);

  // Pull pending+auto_applied suggestions for Acme.
  const sugRows = await db
    .select({
      id: receiptMatchSuggestions.id,
      status: receiptMatchSuggestions.status,
      confidence: receiptMatchSuggestions.confidence,
      amountDiff: receiptMatchSuggestions.amountDiff,
      receiptId: receiptMatchSuggestions.receiptId,
      transactionId: receiptMatchSuggestions.transactionId,
      receiptDate: receipts.receiptDate,
      receiptTotal: receipts.totalAmount,
      receiptPosted: receipts.posted,
      receiptSourceAccount: receipts.sourceAccountId,
      vendorName: contacts.contactName,
    })
    .from(receiptMatchSuggestions)
    .innerJoin(receipts, eq(receiptMatchSuggestions.receiptId, receipts.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(eq(receiptMatchSuggestions.organizationId, acme.id));

  console.log(`\n${sugRows.length} suggestions for Acme:`);
  for (const s of sugRows) {
    console.log(`  ${s.id.slice(0, 8)} | status=${s.status} | conf=${s.confidence} | Δ=${s.amountDiff} | receipt=${s.receiptId.slice(0, 8)} (${s.vendorName ?? '—'} $${s.receiptTotal}, posted=${s.receiptPosted}) | txn=${s.transactionId.slice(0, 8)}`);

    // Lines
    const lines = await db
      .select({
        id: receiptLines.id,
        description: receiptLines.description,
        amount: receiptLines.amount,
        expenseAccountId: receiptLines.expenseAccountId,
        suggestedAccountId: receiptLines.suggestedAccountId,
      })
      .from(receiptLines)
      .where(eq(receiptLines.receiptId, s.receiptId));
    console.log(`    Lines (${lines.length}):`);
    let lineSum = 0;
    for (const l of lines) {
      const acct = l.expenseAccountId ?? l.suggestedAccountId;
      lineSum += Number(l.amount);
      console.log(`      "${l.description}" $${l.amount} | account=${acct ? acct.slice(0, 8) : 'NONE'} (${l.expenseAccountId ? 'confirmed' : l.suggestedAccountId ? 'suggested' : 'missing'})`);
    }
    console.log(`    Line sum: $${lineSum.toFixed(2)}`);

    // Transaction
    const [t] = await db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        accountId: transactions.accountId,
        journalEntryId: transactions.journalEntryId,
        categoryAccountId: transactions.categoryAccountId,
      })
      .from(transactions)
      .where(eq(transactions.id, s.transactionId))
      .limit(1);
    if (t) {
      console.log(`    Txn: amount=${t.amount} | account=${t.accountId?.slice(0, 8) ?? 'NONE'} | je=${t.journalEntryId ? t.journalEntryId.slice(0, 8) : 'none'} | category=${t.categoryAccountId ? t.categoryAccountId.slice(0, 8) : 'none'}`);
    }

    // Auto-apply gate check (top-suggestion logic):
    const conf = Number(s.confidence);
    const diff = Number(s.amountDiff);
    const allLinesAccounted = lines.length > 0 && lines.every((l) => l.expenseAccountId || l.suggestedAccountId);
    const txnAmount = t ? Math.abs(t.amount ?? 0) : 0;
    const lineMatchesTxn = Math.round(lineSum * 100) === Math.round(txnAmount * 100);

    console.log(`    Auto-apply gate:`);
    console.log(`      confidence ≥ 0.9: ${conf >= 0.9 ? 'YES' : 'NO'} (${conf})`);
    console.log(`      amount_diff = 0:  ${diff === 0 ? 'YES' : 'NO'} (${diff})`);
    console.log(`      all lines have account: ${allLinesAccounted ? 'YES' : 'NO'}`);
    console.log(`      line sum ≈ |txn|: ${lineMatchesTxn ? 'YES' : 'NO'} ($${lineSum.toFixed(2)} vs $${txnAmount.toFixed(2)})`);
    console.log(`      txn has source account: ${t?.accountId ? 'YES' : 'NO'}`);
    console.log(`      receipt not yet posted: ${!s.receiptPosted ? 'YES' : 'NO'}`);

    // Application
    const [app] = await db
      .select({ id: receiptMatchApplications.id, reversedAt: receiptMatchApplications.reversedAt })
      .from(receiptMatchApplications)
      .where(eq(receiptMatchApplications.suggestionId, s.id))
      .limit(1);
    console.log(`    Application: ${app ? `${app.id.slice(0, 8)} reversed=${app.reversedAt ?? 'no'}` : 'none'}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
