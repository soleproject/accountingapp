'use server';

import { revalidatePath } from 'next/cache';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { logger } from '@/lib/logger';

export interface PostReceiptState {
  error?: string;
}

/**
 * Post a categorized receipt to the GL.
 *
 * Preconditions:
 *   - Receipt exists, not already posted.
 *   - source_account_id set (the "paid from" account: Cash / Credit Card /
 *     Owner's Funds — the credit side of the JE).
 *   - Every receipt_line has an expense_account_id set.
 *
 * JE shape: one debit line per expense account (lines collapsed by
 * account so a receipt with 3 "Meals" rows produces a single debit to
 * Meals & Entertainment), one credit to source_account_id for the
 * total. Mirrors createBill's posting shape.
 */
export async function postReceipt(receiptId: string): Promise<PostReceiptState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [r] = await db
    .select({
      id: receipts.id,
      receiptDate: receipts.receiptDate,
      contactId: receipts.contactId,
      memo: receipts.memo,
      totalAmount: receipts.totalAmount,
      posted: receipts.posted,
      sourceAccountId: receipts.sourceAccountId,
    })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)))
    .limit(1);
  if (!r) return { error: 'Receipt not found' };
  if (r.posted) return { error: 'Receipt is already posted' };
  if (!r.sourceAccountId) return { error: 'Choose a "Paid from" account before posting' };
  if (!r.receiptDate) return { error: 'Receipt has no date — set one before posting' };

  const lines = await db
    .select({
      id: receiptLines.id,
      description: receiptLines.description,
      amount: receiptLines.amount,
      expenseAccountId: receiptLines.expenseAccountId,
    })
    .from(receiptLines)
    .where(eq(receiptLines.receiptId, receiptId));

  if (lines.length === 0) return { error: 'Receipt has no lines to categorize' };
  const uncategorized = lines.find((l) => !l.expenseAccountId);
  if (uncategorized) return { error: 'Every line needs an expense account before posting' };

  // Collapse lines by account so the JE has one debit per distinct
  // expense account rather than N (matches createBill's behavior).
  const byAccount = new Map<string, number>();
  for (const l of lines) {
    const amt = Number(l.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    byAccount.set(l.expenseAccountId!, (byAccount.get(l.expenseAccountId!) ?? 0) + amt);
  }
  const lineTotal = Array.from(byAccount.values()).reduce((s, n) => s + n, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // If Veryfi's total disagrees with the line sum (taxes/tips/rounding),
  // trust the line sum for the JE — the user has explicitly categorized
  // those amounts. Surface a warning via the receipt total for visibility.
  const total = round2(lineTotal);
  if (total <= 0) return { error: 'Line amounts sum to zero — nothing to post' };

  try {
    await db.transaction(async (tx) => {
      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: r.receiptDate!,
          memo: r.memo ?? 'Receipt',
          posted: true,
          sourceType: 'receipt',
          sourceId: r.id,
          lines: [
            ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
              accountId,
              debit: round2(amount),
              credit: 0,
              contactId: r.contactId,
              memo: r.memo ?? null,
            })),
            {
              accountId: r.sourceAccountId!,
              debit: 0,
              credit: total,
              contactId: r.contactId,
              memo: r.memo ?? null,
            },
          ],
        },
        tx,
      );

      await tx
        .update(receipts)
        .set({
          posted: true,
          status: 'posted',
          postedAt: new Date().toISOString(),
          journalEntryId: je.id,
          totalAmount: total,
        })
        .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)));
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  logger.info({ receiptId, total }, 'receipt posted');
  revalidatePath(`/receipts/${receiptId}`);
  revalidatePath('/receipts');
  return undefined;
}
