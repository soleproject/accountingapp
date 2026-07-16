'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptMatchSuggestions, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { applyReceiptMatch, ApplyMatchError } from '@/lib/receipts/apply-match';
import { logger } from '@/lib/logger';

export interface ManualLinkState {
  error?: string;
}

/**
 * Manually link a receipt to a transaction the user picked from the
 * dropdown on the receipt detail page. Synthesizes a receipt_match_
 * suggestions row (or revives an existing one back to 'pending') and
 * runs the same applyReceiptMatch flow auto-apply uses — same JE,
 * splits, contact propagation, audit trail.
 *
 * Used when the matcher couldn't find or didn't propose the right txn
 * automatically (different date, different amount, no Plaid sync, etc.)
 * and the user knows which one it should be.
 */
export async function manualLinkReceiptToTransaction(
  receiptId: string,
  transactionId: string,
): Promise<ManualLinkState | undefined> {
  if (!receiptId || !transactionId) return { error: 'Receipt and transaction are required' };
  const orgId = await getCurrentOrgId();

  const [r] = await db
    .select({ id: receipts.id, totalAmount: receipts.totalAmount, receiptDate: receipts.receiptDate, contactId: receipts.contactId })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)))
    .limit(1);
  if (!r) return { error: 'Receipt not found' };

  const [t] = await db
    .select({ id: transactions.id, amount: transactions.amount, date: transactions.date, contactId: transactions.contactId })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!t) return { error: 'Transaction not found' };

  // Build a synthetic suggestion (or upsert the existing one) — apply
  // needs a pending row to point at. Confidence 1.0 since the user
  // explicitly chose this pair; amount/date deltas are informational.
  const txnAmount = Math.abs(t.amount ?? 0);
  const amountDiff = Math.abs(txnAmount - (r.totalAmount ?? 0));
  let dateDiffDays = 0;
  if (r.receiptDate && t.date) {
    const ms = Math.abs(new Date(t.date).getTime() - new Date(r.receiptDate).getTime());
    if (Number.isFinite(ms)) dateDiffDays = Math.round(ms / 86_400_000);
  }
  const vendorMatch = !!(r.contactId && t.contactId && r.contactId === t.contactId);

  const now = new Date().toISOString();
  const [existing] = await db
    .select({ id: receiptMatchSuggestions.id, status: receiptMatchSuggestions.status })
    .from(receiptMatchSuggestions)
    .where(
      and(
        eq(receiptMatchSuggestions.receiptId, receiptId),
        eq(receiptMatchSuggestions.transactionId, transactionId),
      ),
    )
    .limit(1);

  let suggestionId: string;
  if (existing) {
    await db
      .update(receiptMatchSuggestions)
      .set({
        status: 'pending',
        confidence: '1.000',
        amountDiff: amountDiff.toFixed(2),
        dateDiffDays,
        vendorMatch,
        updatedAt: now,
      })
      .where(eq(receiptMatchSuggestions.id, existing.id));
    suggestionId = existing.id;
  } else {
    suggestionId = randomUUID();
    await db.insert(receiptMatchSuggestions).values({
      id: suggestionId,
      organizationId: orgId,
      receiptId,
      transactionId,
      confidence: '1.000',
      amountDiff: amountDiff.toFixed(2),
      dateDiffDays,
      vendorMatch,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    const result = await applyReceiptMatch({ organizationId: orgId, suggestionId });
    logger.info(
      { receiptId, transactionId, suggestionId, applicationId: result.applicationId },
      'receipt manually linked + applied to transaction',
    );
  } catch (err) {
    if (err instanceof ApplyMatchError) return { error: err.message };
    throw err;
  }

  revalidatePath(`/receipts/${receiptId}`);
  revalidatePath('/receipts');
  revalidatePath('/transactions');
  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath('/ai-chat');
  return undefined;
}
