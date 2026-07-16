/**
 * Re-run findTransactionMatches against every receipt in the DB. Useful
 * after a matcher rules change (date window, amount tolerance, sign
 * filter) — receipts uploaded under the old rules get re-scored under
 * the new ones without needing to re-upload.
 *
 * Safe to re-run: the upsert in findTransactionMatches updates
 * confidence on (receipt_id, transaction_id) without resetting status
 * (so a user-dismissed suggestion stays dismissed).
 *
 * Run: npx tsx scripts/backfill-receipt-transaction-matches.ts
 */
import { config } from 'dotenv';
import { asc } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { receipts } = await import('../db/schema/schema');
  const { findTransactionMatches } = await import('../lib/receipts/find-transaction-matches');

  const all = await db
    .select({
      id: receipts.id,
      organizationId: receipts.organizationId,
      totalAmount: receipts.totalAmount,
      receiptDate: receipts.receiptDate,
      contactId: receipts.contactId,
    })
    .from(receipts)
    .orderBy(asc(receipts.id));

  console.log(`Backfilling matches for ${all.length} receipts…`);
  let totalPersisted = 0;
  let withMatches = 0;
  for (const r of all) {
    try {
      const n = await findTransactionMatches({
        id: r.id,
        organizationId: r.organizationId,
        totalAmount: r.totalAmount,
        receiptDate: r.receiptDate,
        contactId: r.contactId,
      });
      if (n > 0) {
        withMatches += 1;
        totalPersisted += n;
        console.log(`  ${r.id.slice(0, 8)} → ${n} suggestion(s)`);
      }
    } catch (err) {
      console.error(`  ${r.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nDone. ${withMatches}/${all.length} receipts got at least one suggestion (${totalPersisted} total).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
