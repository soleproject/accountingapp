'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { receipts, receiptMatchApplications, receiptMatchSuggestions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { undoReceiptMatch, UndoMatchError } from '@/lib/receipts/undo-match';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';

export interface DeleteReceiptState {
  error?: string;
}

export async function deleteReceipt(receiptId: string): Promise<DeleteReceiptState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [r] = await db
    .select({ id: receipts.id, journalEntryId: receipts.journalEntryId })
    .from(receipts)
    .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)))
    .limit(1);
  if (!r) return { error: 'Receipt not found' };

  // If this receipt was auto-applied to a transaction, unwind the
  // application BEFORE the delete: reverses the JE we wrote, drops the
  // receipt-match splits, restores the txn's pre-state, and flips
  // reversed_at on the application so the "Linked Receipt" pill stops
  // rendering on /transactions and /transactions/[id]. Without this
  // the pill would point at a 404 after delete. We capture txn ids
  // here so we can revalidate the right detail pages below.
  const activeApps = await db
    .select({ id: receiptMatchApplications.id, transactionId: receiptMatchApplications.transactionId })
    .from(receiptMatchApplications)
    .where(
      and(
        eq(receiptMatchApplications.receiptId, receiptId),
        eq(receiptMatchApplications.organizationId, orgId),
        isNull(receiptMatchApplications.reversedAt),
      ),
    );
  for (const app of activeApps) {
    try {
      await undoReceiptMatch({ organizationId: orgId, applicationId: app.id });
    } catch (err) {
      if (err instanceof UndoMatchError) return { error: err.message };
      throw err;
    }
  }

  try {
    await db.transaction(async (tx) => {
      // After undoReceiptMatch ran (if any), the receipt's
      // journal_entry_id has been nulled out — so this branch only
      // fires for receipts posted via the manual postReceipt path
      // (which we don't touch above). Re-read to get the latest
      // journalEntryId in case undo updated it.
      const [latest] = await tx
        .select({ journalEntryId: receipts.journalEntryId })
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)))
        .limit(1);
      if (latest?.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: latest.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal of deleted receipt ${receiptId.slice(0, 8)}`,
          },
          tx,
        );
      }
      // Pending suggestions for this receipt would otherwise resurface
      // on /ai-chat pointing at a 404 — clean them up. Already-
      // reviewed (accepted/dismissed/auto_applied) suggestions stay
      // for audit.
      await tx
        .delete(receiptMatchSuggestions)
        .where(
          and(
            eq(receiptMatchSuggestions.receiptId, receiptId),
            eq(receiptMatchSuggestions.status, 'pending'),
          ),
        );
      await tx
        .delete(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.organizationId, orgId)));
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  revalidatePath('/receipts');
  revalidatePath('/transactions');
  for (const app of activeApps) {
    revalidatePath(`/transactions/${app.transactionId}`);
  }
  revalidatePath('/ai-chat');
  return undefined;
}
