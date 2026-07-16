'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, transactionSplits, receiptMatchApplications } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { undoReceiptMatch, UndoMatchError } from '@/lib/receipts/undo-match';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError } from '@/lib/billing/entitlements';

export interface UnsplitTransactionState {
  error?: string;
}

/**
 * Collapse a split transaction back to a single-category posting. Uses the
 * first split row's account as the new category — user can change it via
 * the normal Categorize form afterward.
 */
export async function unsplitTransaction(
  transactionId: string,
  _prev: UnsplitTransactionState | undefined,
  _formData: FormData,
): Promise<UnsplitTransactionState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const [txn] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return { error: 'Transaction not found in this organization' };
  if (txn.amount == null) return { error: 'Transaction has no amount' };
  if (!txn.type) return { error: 'Transaction has no type' };
  if (!txn.accountId) return { error: 'Transaction has no bank account' };

  try {
    await requireDateCovered(orgId, txn.date);
  } catch (e) {
    if (e instanceof DateNotCoveredError) return { error: e.message };
    throw e;
  }

  // If this transaction's splits came from an auto-applied receipt
  // match, "Remove split" should fully unwind the receipt link — not
  // collapse to the first split's account. undoReceiptMatch reverses
  // the JE we wrote, drops the receipt-match splits, restores the
  // transaction + receipt pre-state, and flips the application row so
  // the Linked Receipt pill disappears from the list and detail.
  const [activeApp] = await db
    .select({ id: receiptMatchApplications.id })
    .from(receiptMatchApplications)
    .where(
      and(
        eq(receiptMatchApplications.transactionId, transactionId),
        eq(receiptMatchApplications.organizationId, orgId),
        isNull(receiptMatchApplications.reversedAt),
      ),
    )
    .limit(1);
  if (activeApp) {
    try {
      await undoReceiptMatch({ organizationId: orgId, applicationId: activeApp.id });
    } catch (err) {
      if (err instanceof UndoMatchError) return { error: err.message };
      throw err;
    }
    revalidatePath('/transactions');
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath('/ai-chat');
    return undefined;
  }

  const splits = await db
    .select()
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, transactionId))
    .orderBy(asc(transactionSplits.position));
  if (splits.length === 0) return { error: 'This transaction is not split.' };

  const ttype = txn.type.toLowerCase();
  if (ttype !== 'deposit' && ttype !== 'withdrawal') {
    return { error: `Cannot unsplit a ${txn.type} transaction` };
  }
  const isDeposit = ttype === 'deposit';
  const total = txn.amount;
  const primaryAccountId = splits[0]!.categoryAccountId;
  const memoBase = txn.userDescription ?? txn.bankDescription ?? txn.description ?? null;

  try {
    await db.transaction(async (tx) => {
      if (txn.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: txn.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal for unsplit of transaction ${transactionId.slice(0, 8)}`,
          },
          tx,
        );
      }

      const categoryLine = {
        accountId: primaryAccountId,
        debit: isDeposit ? 0 : total,
        credit: isDeposit ? total : 0,
        contactId: txn.contactId ?? null,
        memo: memoBase,
      };
      const bankLine = {
        accountId: txn.accountId!,
        debit: isDeposit ? total : 0,
        credit: isDeposit ? 0 : total,
        contactId: txn.contactId ?? null,
        memo: memoBase,
      };
      const jeLines = isDeposit ? [bankLine, categoryLine] : [categoryLine, bankLine];

      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: txn.date,
          memo: memoBase ?? `Unsplit ${txn.type}`,
          posted: true,
          sourceType: 'transaction',
          sourceId: transactionId,
          lines: jeLines,
        },
        tx,
      );

      await tx
        .update(transactions)
        .set({
          categoryAccountId: primaryAccountId,
          journalEntryId: je.id,
          reviewed: true,
        })
        .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)));

      await tx
        .delete(transactionSplits)
        .where(eq(transactionSplits.transactionId, transactionId));
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  revalidatePath('/transactions');
  revalidatePath(`/transactions/${transactionId}`);
  return undefined;
}
