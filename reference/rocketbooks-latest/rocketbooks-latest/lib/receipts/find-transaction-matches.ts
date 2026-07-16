// No `server-only` directive: this helper is called from backfill
// scripts via tsx, which doesn't ship the `server-only` package. The
// function only touches the DB layer (itself server-only), so the
// guard is redundant.
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, receiptMatchSuggestions } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

interface ReceiptForMatch {
  id: string;
  organizationId: string;
  totalAmount: number;
  receiptDate: string | null;
  contactId: string | null;
}

/**
 * For a freshly-uploaded receipt, find transactions that match
 * EXACTLY and persist them to receipt_match_suggestions.
 *
 * Match criteria (all required):
 *   - Same org.
 *   - |transactions.amount| === receipt.total (exact, to the cent).
 *   - transactions.date === receipt.receiptDate.
 *
 * No date window, no amount tolerance. Tip-included or off-by-cents
 * cases that used to fuzzy-match get handled by the manual
 * link-to-transaction picker on the receipt detail page now. Strict
 * matching keeps confidence trustworthy — every persisted suggestion
 * is a clean dollar-and-day match, so auto-apply can fire on them.
 *
 * Returns the count of suggestions persisted. Upsert on
 * (receipt_id, transaction_id) so re-runs refresh without duplicating;
 * status stays whatever it was so a user-dismissed suggestion doesn't
 * resurrect.
 */
export async function findTransactionMatches(receipt: ReceiptForMatch): Promise<number> {
  if (!receipt.receiptDate) {
    logger.info({ receiptId: receipt.id }, 'findTransactionMatches: receipt has no date — skipping');
    return 0;
  }
  if (!Number.isFinite(receipt.totalAmount) || receipt.totalAmount <= 0) {
    logger.info({ receiptId: receipt.id }, 'findTransactionMatches: non-positive total — skipping');
    return 0;
  }

  // Normalise the receipt's date to YYYY-MM-DD so a Veryfi timestamp
  // ('2026-01-27 17:28:00') still matches a Plaid-style date ('2026-01-27').
  const receiptDayOnly = receipt.receiptDate.slice(0, 10);

  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      contactId: transactions.contactId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, receipt.organizationId),
        // Exact amount match (sign-agnostic — manual entries store
        // outflows as positive, Plaid stores them as negative).
        sql`ABS(${transactions.amount}) = ${receipt.totalAmount}`,
        eq(transactions.date, receiptDayOnly),
      ),
    );

  if (rows.length === 0) {
    logger.info({ receiptId: receipt.id }, 'findTransactionMatches: no exact-match candidates');
    return 0;
  }

  const now = new Date().toISOString();
  const values = rows.map((t) => {
    const vendorMatch = !!(receipt.contactId && t.contactId && receipt.contactId === t.contactId);
    return {
      id: randomUUID(),
      organizationId: receipt.organizationId,
      receiptId: receipt.id,
      transactionId: t.id,
      // Exact match → confidence is high. Vendor agreement nudges it
      // to 1.0; otherwise 0.95 (still well above the 0.9 auto-apply
      // bar).
      confidence: vendorMatch ? '1.000' : '0.950',
      amountDiff: '0.00',
      dateDiffDays: 0,
      vendorMatch,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  });

  await db
    .insert(receiptMatchSuggestions)
    .values(values)
    .onConflictDoUpdate({
      target: [receiptMatchSuggestions.receiptId, receiptMatchSuggestions.transactionId],
      set: {
        confidence: sql`excluded.confidence`,
        amountDiff: sql`excluded.amount_diff`,
        dateDiffDays: sql`excluded.date_diff_days`,
        vendorMatch: sql`excluded.vendor_match`,
        updatedAt: now,
      },
    });

  logger.info(
    { receiptId: receipt.id, matches: rows.length },
    'findTransactionMatches: exact-match suggestions persisted',
  );
  return rows.length;
}
