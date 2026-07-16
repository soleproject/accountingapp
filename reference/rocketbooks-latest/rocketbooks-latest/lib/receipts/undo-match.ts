import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  receipts,
  receiptMatchSuggestions,
  receiptMatchApplications,
  transactions,
  transactionSplits,
} from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { logger } from '@/lib/logger';

export class UndoMatchError extends Error {}

interface PreState {
  transaction: {
    journalEntryId: string | null;
    categoryAccountId: string | null;
    reviewed: boolean | null;
    /** Older applications didn't snapshot contactId; undefined here
     *  means "leave the transaction's current contact untouched." */
    contactId?: string | null;
  };
  receipt: {
    posted: boolean;
    status: string;
    journalEntryId: string | null;
    sourceAccountId: string | null;
  };
}

/**
 * Undo an auto-applied receipt match.
 *
 * Flow (one DB transaction):
 *   1. Read the application snapshot (idempotent: returns early if
 *      already reversed).
 *   2. Reverse the new JE we created at apply time (creates a reversing
 *      entry; original new JE stays in the audit trail).
 *   3. Delete the transaction_splits we wrote (identified by
 *      intent='receipt-match' + intent_target_id=receipt_id, so the
 *      user's later manual splits on the same txn aren't touched).
 *   4. Restore the transaction's pre-state (journalEntryId,
 *      categoryAccountId, reviewed). Note: if the transaction had an
 *      old JE, that JE was reversed during apply — so the restored
 *      journalEntryId points at a JE whose GL impact is now zero
 *      (reversal-1 canceled it). Books net to zero either way; the
 *      user can manually re-categorize if they want the original
 *      effect back.
 *   5. Restore the receipt's pre-state.
 *   6. Suggestion status → 'pending' so it surfaces on /ai-chat again
 *      and the user can review manually.
 *   7. Application.reversed_at = now (idempotency marker).
 */
export async function undoReceiptMatch(input: {
  organizationId: string;
  applicationId: string;
}): Promise<{ alreadyReversed: boolean }> {
  return await db.transaction(async (tx) => {
    const [app] = await tx
      .select({
        id: receiptMatchApplications.id,
        suggestionId: receiptMatchApplications.suggestionId,
        receiptId: receiptMatchApplications.receiptId,
        transactionId: receiptMatchApplications.transactionId,
        newJournalEntryId: receiptMatchApplications.newJournalEntryId,
        preState: receiptMatchApplications.preState,
        reversedAt: receiptMatchApplications.reversedAt,
      })
      .from(receiptMatchApplications)
      .where(
        and(
          eq(receiptMatchApplications.id, input.applicationId),
          eq(receiptMatchApplications.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!app) throw new UndoMatchError('Application not found');
    if (app.reversedAt) return { alreadyReversed: true };

    const pre = app.preState as PreState;

    // 1. Reverse the JE the transaction CURRENTLY points at, in addition
    //    to the snapshotted newJournalEntryId. Between apply and undo,
    //    splitTransaction / unsplitTransaction / categorizeTransaction
    //    may have replaced the JE — they reverse the old one and create
    //    a new one but don't update receipt_match_applications. Without
    //    reversing the txn's CURRENT JE we leave the books with an
    //    orphan JE contributing to the GL. reverseJournalEntry is
    //    idempotent (returns the existing reverser if one already
    //    exists), so reversing both is safe even when they're the same
    //    or one's already been reversed.
    const [currentTxn] = await tx
      .select({ journalEntryId: transactions.journalEntryId })
      .from(transactions)
      .where(eq(transactions.id, app.transactionId))
      .limit(1);
    const jesToReverse = new Set<string>([app.newJournalEntryId]);
    if (currentTxn?.journalEntryId) jesToReverse.add(currentTxn.journalEntryId);
    try {
      for (const jeId of jesToReverse) {
        await reverseJournalEntry(
          {
            organizationId: input.organizationId,
            journalEntryId: jeId,
            reversalMemo: 'Undo receipt match',
          },
          tx,
        );
      }
    } catch (err) {
      if (err instanceof JournalEntryError) throw new UndoMatchError(err.message);
      throw err;
    }

    // 2. Delete ALL splits on this transaction. apply-match wipes
    //    pre-existing splits before inserting its own, so any splits
    //    sitting here now were either created by apply-match directly
    //    OR by a subsequent splitTransaction edit (which doesn't carry
    //    the intent='receipt-match' tag). Either way they're the
    //    receipt's splits — wiping them is correct.
    await tx
      .delete(transactionSplits)
      .where(eq(transactionSplits.transactionId, app.transactionId));

    // 3. Pull the txn so we can build a fresh JE matching the
    //    pre-apply categorize state, then restore the snapshot fields.
    const [txn] = await tx
      .select({
        id: transactions.id,
        date: transactions.date,
        amount: transactions.amount,
        type: transactions.type,
        accountId: transactions.accountId,
        userDescription: transactions.userDescription,
        bankDescription: transactions.bankDescription,
        description: transactions.description,
      })
      .from(transactions)
      .where(eq(transactions.id, app.transactionId))
      .limit(1);
    if (!txn) throw new UndoMatchError('Transaction vanished during undo');

    // If the pre-state had a journal entry, the txn WAS posted before
    // the receipt-match apply. That pre-apply JE got reversed during
    // apply (and stays reversed — `reverseJournalEntry` refuses to
    // reverse a reversal), so restoring the snapshot's journalEntryId
    // would point the txn at a JE whose GL impact is zero. Build a
    // fresh JE matching the pre-state categorization so the books
    // reflect the txn's restored category. When the pre-state had no
    // JE (txn was uncategorized before apply), skip the rebuild.
    let restoredJournalEntryId = pre.transaction.journalEntryId;
    const ttype = (txn.type ?? '').toLowerCase();
    const canRebuildJe =
      pre.transaction.journalEntryId &&
      pre.transaction.categoryAccountId &&
      txn.accountId &&
      txn.amount != null &&
      (ttype === 'deposit' || ttype === 'withdrawal');
    if (canRebuildJe) {
      const isDeposit = ttype === 'deposit';
      const memoBase =
        txn.userDescription ?? txn.bankDescription ?? txn.description ?? null;
      const total = Math.abs(txn.amount!);
      const categoryLine = {
        accountId: pre.transaction.categoryAccountId!,
        debit: isDeposit ? 0 : total,
        credit: isDeposit ? total : 0,
        contactId: pre.transaction.contactId ?? null,
        memo: memoBase,
      };
      const bankLine = {
        accountId: txn.accountId!,
        debit: isDeposit ? total : 0,
        credit: isDeposit ? 0 : total,
        contactId: pre.transaction.contactId ?? null,
        memo: memoBase,
      };
      try {
        const newJe = await createJournalEntry(
          {
            organizationId: input.organizationId,
            date: txn.date,
            memo: memoBase ?? `Restored ${txn.type ?? 'transaction'}`,
            posted: true,
            sourceType: 'transaction',
            sourceId: txn.id,
            lines: isDeposit ? [bankLine, categoryLine] : [categoryLine, bankLine],
          },
          tx,
        );
        restoredJournalEntryId = newJe.id;
      } catch (err) {
        if (err instanceof JournalEntryError) throw new UndoMatchError(err.message);
        throw err;
      }
    }

    // 4. Restore the transaction. contactId is only restored when the
    //    snapshot has it (newer applications); older snapshots leave
    //    the current contactId alone.
    const txnRestore: {
      journalEntryId: string | null;
      categoryAccountId: string | null;
      reviewed: boolean;
      contactId?: string | null;
    } = {
      journalEntryId: restoredJournalEntryId,
      categoryAccountId: pre.transaction.categoryAccountId,
      reviewed: pre.transaction.reviewed ?? false,
    };
    if (pre.transaction.contactId !== undefined) {
      txnRestore.contactId = pre.transaction.contactId;
    }
    await tx
      .update(transactions)
      .set(txnRestore)
      .where(eq(transactions.id, app.transactionId));

    // 4. Restore the receipt.
    await tx
      .update(receipts)
      .set({
        posted: pre.receipt.posted,
        status: pre.receipt.status,
        journalEntryId: pre.receipt.journalEntryId,
        sourceAccountId: pre.receipt.sourceAccountId,
        postedAt: pre.receipt.posted ? undefined : null,
      })
      .where(eq(receipts.id, app.receiptId));

    // 5. Suggestion back to pending. Other suggestions on this receipt
    //    were 'superseded' at apply time — those stay superseded; if
    //    the user wants to consider them, they can re-run the matcher.
    const now = new Date().toISOString();
    await tx
      .update(receiptMatchSuggestions)
      .set({ status: 'pending', updatedAt: now })
      .where(eq(receiptMatchSuggestions.id, app.suggestionId));

    // 6. Mark this application reversed.
    await tx
      .update(receiptMatchApplications)
      .set({ reversedAt: now })
      .where(eq(receiptMatchApplications.id, app.id));

    logger.info(
      { applicationId: app.id, receiptId: app.receiptId, transactionId: app.transactionId },
      'receipt match auto-apply reversed',
    );

    return { alreadyReversed: false };
  });
}
