/**
 * Backfill txn.contact_id for transactions that have an active
 * receipt-match application but no contact set. These are rows that
 * were auto-applied before applyReceiptMatch knew to propagate the
 * receipt's contact onto the transaction.
 *
 * Defaults to dry-run. Pass --apply to commit.
 *
 * Run:
 *   npx tsx scripts/backfill-linked-receipt-contacts.ts          # dry-run
 *   npx tsx scripts/backfill-linked-receipt-contacts.ts --apply  # commit
 */
import { config } from 'dotenv';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const apply = process.argv.includes('--apply');
  const { db } = await import('../db/client');
  const { receiptMatchApplications, receipts, transactions, contacts } = await import('../db/schema/schema');

  const rows = await db
    .select({
      txnId: transactions.id,
      txnContactId: transactions.contactId,
      receiptContactId: receipts.contactId,
      receiptVendor: contacts.contactName,
      appId: receiptMatchApplications.id,
      reversedAt: receiptMatchApplications.reversedAt,
    })
    .from(receiptMatchApplications)
    .innerJoin(transactions, eq(receiptMatchApplications.transactionId, transactions.id))
    .innerJoin(receipts, eq(receiptMatchApplications.receiptId, receipts.id))
    .leftJoin(contacts, eq(receipts.contactId, contacts.id))
    .where(
      and(
        isNull(receiptMatchApplications.reversedAt),
        isNull(transactions.contactId),
        isNotNull(receipts.contactId),
      ),
    );

  console.log(`Found ${rows.length} linked-receipt txn(s) with no contact — ${apply ? 'applying' : 'dry-run'}`);
  for (const r of rows) {
    console.log(`  txn ${r.txnId.slice(0, 8)} ← receipt contact ${r.receiptContactId?.slice(0, 8)} (${r.receiptVendor})`);
    if (apply && r.receiptContactId) {
      await db
        .update(transactions)
        .set({ contactId: r.receiptContactId })
        .where(eq(transactions.id, r.txnId));
    }
  }
  if (!apply) console.log('\nNo DB writes performed — re-run with --apply to commit.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
