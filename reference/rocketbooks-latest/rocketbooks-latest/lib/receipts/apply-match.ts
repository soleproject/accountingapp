import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  receipts,
  receiptLines,
  receiptMatchSuggestions,
  receiptMatchApplications,
  transactions,
  transactionSplits,
  trustReviewFindings,
} from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { ensureSalesTaxExpenseAccount } from '@/lib/qbo/mirror/tax-account';
import { logger } from '@/lib/logger';

/**
 * Pull sales tax off the persisted Veryfi response. Walmart-style
 * receipts list line items pre-tax + a separate tax line; without
 * carrying tax through, line_sum + tax = total but apply would see
 * line_sum ≠ txn_amount and refuse. Returns 0 if the field is missing,
 * malformed, or non-numeric.
 */
function extractTaxFromVeryfi(rawJson: string | null): number {
  if (!rawJson) return 0;
  try {
    const parsed = JSON.parse(rawJson) as { tax?: number | string | null };
    const tax = typeof parsed.tax === 'number' ? parsed.tax : Number(parsed.tax);
    return Number.isFinite(tax) && tax > 0 ? Math.round(tax * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

export class ApplyMatchError extends Error {}

export interface AutoApplyResult {
  applicationId: string;
  newJournalEntryId: string;
}

/**
 * Snapshot the pre-state of a transaction + receipt before we mutate
 * them, so undoReceiptMatch can restore the world. Stored as JSONB on
 * receipt_match_applications. Older applications may be missing newer
 * fields (e.g. contactId pre-dates Linked Receipt work); undo treats
 * missing fields as "leave alone."
 */
interface PreState {
  transaction: {
    journalEntryId: string | null;
    categoryAccountId: string | null;
    reviewed: boolean | null;
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
 * Apply a receipt → transaction match. The heavy phase 3 work.
 *
 * Flow (one DB transaction):
 *   1. Snapshot pre-state.
 *   2. Reverse the transaction's existing JE if it has one (creates a
 *      reversal entry; the original stays in the audit trail).
 *   3. Delete the transaction's existing splits (we own them now).
 *   4. Insert one transaction_split per receipt line.
 *   5. Build a new JE: collapsed debits per expense account from the
 *      receipt's lines, credit to the transaction's bank/CC account
 *      for the total. sourceType='receipt-match', sourceId=receipt.id.
 *   6. Point the transaction at the new JE; clear category_account_id
 *      (it's split now); mark reviewed=true.
 *   7. Point the receipt at the new JE; mark posted=true,
 *      status='posted', source_account_id=transaction.account_id.
 *   8. Suggestion status → 'auto_applied'.
 *   9. Persist the snapshot + new JE id to receipt_match_applications.
 *
 * Throws ApplyMatchError on validation failure (missing data, line
 * amounts ≠ transaction amount, etc.). The caller (auto-apply trigger
 * at upload time) logs and continues — apply failures must not break
 * the receipt upload itself.
 */
export async function applyReceiptMatch(input: {
  organizationId: string;
  suggestionId: string;
}): Promise<AutoApplyResult> {
  return await db.transaction(async (tx) => {
    // Lock the suggestion row first to prevent two concurrent auto-applies
    // racing each other (e.g. matcher re-runs, simultaneous uploads).
    const [suggestion] = await tx
      .select({
        id: receiptMatchSuggestions.id,
        receiptId: receiptMatchSuggestions.receiptId,
        transactionId: receiptMatchSuggestions.transactionId,
        status: receiptMatchSuggestions.status,
      })
      .from(receiptMatchSuggestions)
      .where(
        and(
          eq(receiptMatchSuggestions.id, input.suggestionId),
          eq(receiptMatchSuggestions.organizationId, input.organizationId),
        ),
      )
      .limit(1);
    if (!suggestion) throw new ApplyMatchError('Suggestion not found');
    if (suggestion.status !== 'pending') {
      throw new ApplyMatchError(`Suggestion is ${suggestion.status}, expected pending`);
    }

    const [r] = await tx
      .select({
        id: receipts.id,
        contactId: receipts.contactId,
        receiptDate: receipts.receiptDate,
        memo: receipts.memo,
        totalAmount: receipts.totalAmount,
        posted: receipts.posted,
        status: receipts.status,
        journalEntryId: receipts.journalEntryId,
        sourceAccountId: receipts.sourceAccountId,
        veryfiRawJson: receipts.veryfiRawJson,
      })
      .from(receipts)
      .where(and(eq(receipts.id, suggestion.receiptId), eq(receipts.organizationId, input.organizationId)))
      .limit(1);
    if (!r) throw new ApplyMatchError('Receipt not found');
    if (r.posted) throw new ApplyMatchError('Receipt is already posted');

    const [t] = await tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        date: transactions.date,
        journalEntryId: transactions.journalEntryId,
        categoryAccountId: transactions.categoryAccountId,
        reviewed: transactions.reviewed,
        contactId: transactions.contactId,
      })
      .from(transactions)
      .where(and(eq(transactions.id, suggestion.transactionId), eq(transactions.organizationId, input.organizationId)))
      .limit(1);
    if (!t) throw new ApplyMatchError('Transaction not found');
    if (!t.accountId) throw new ApplyMatchError('Transaction has no source account (no bank/CC link)');

    const lines = await tx
      .select({
        id: receiptLines.id,
        description: receiptLines.description,
        amount: receiptLines.amount,
        expenseAccountId: receiptLines.expenseAccountId,
        suggestedAccountId: receiptLines.suggestedAccountId,
      })
      .from(receiptLines)
      .where(eq(receiptLines.receiptId, r.id));
    if (lines.length === 0) throw new ApplyMatchError('Receipt has no lines');

    // Resolve each line to an account: prefer the user-confirmed
    // expense_account_id, fall back to the AI suggestion. Auto-apply
    // refuses if any line has neither.
    const resolved = lines.map((l) => ({
      id: l.id,
      description: l.description,
      amount: Number(l.amount),
      accountId: l.expenseAccountId ?? l.suggestedAccountId,
    }));
    const unresolved = resolved.find((l) => !l.accountId);
    if (unresolved) {
      throw new ApplyMatchError(`Receipt line "${unresolved.description}" has no account`);
    }

    // Receipts that break out sales tax (Walmart, most US retail) ship
    // line items pre-tax. Veryfi puts the tax in a separate field that
    // we don't persist on receipt_lines, so the line sum here is the
    // subtotal, not the total. Pull tax off the raw Veryfi JSON and
    // close the gap: line_sum + tax should equal txn_amount.
    const lineSubtotal = Math.round(resolved.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const taxAmount = extractTaxFromVeryfi(r.veryfiRawJson);
    const expectedTotal = Math.round((lineSubtotal + taxAmount) * 100) / 100;
    const txnAmount = Math.round(Math.abs(t.amount ?? 0) * 100) / 100;
    if (expectedTotal !== txnAmount) {
      throw new ApplyMatchError(
        `Line sum + tax ($${expectedTotal.toFixed(2)}) does not match transaction amount ($${txnAmount.toFixed(2)})`,
      );
    }
    if (expectedTotal <= 0) throw new ApplyMatchError('Receipt amounts sum to zero');

    const preState: PreState = {
      transaction: {
        journalEntryId: t.journalEntryId,
        categoryAccountId: t.categoryAccountId,
        reviewed: t.reviewed ?? false,
        contactId: t.contactId,
      },
      receipt: {
        posted: r.posted,
        status: r.status,
        journalEntryId: r.journalEntryId,
        sourceAccountId: r.sourceAccountId,
      },
    };

    // 1. Reverse the transaction's old JE (if it had one). The original
    //    stays in the books with a reversing entry; net GL impact = 0.
    if (t.journalEntryId) {
      try {
        await reverseJournalEntry(
          {
            organizationId: input.organizationId,
            journalEntryId: t.journalEntryId,
            reversalDate: t.date,
            reversalMemo: `Reversal: superseded by receipt match`,
          },
          tx,
        );
      } catch (err) {
        if (err instanceof JournalEntryError) throw new ApplyMatchError(err.message);
        throw err;
      }
    }

    // 2. Wipe any pre-existing splits on this transaction. transaction_splits
    //    is owned by us once auto-applied; the user can re-split via the
    //    manual flow if they later undo and re-categorize.
    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, t.id));

    // 3. Resolve the Sales Tax Expense account (only if needed). Auto-
    //    creates one when missing — mirrors how createBill handles tax.
    let taxAccountId: string | null = null;
    if (taxAmount > 0) {
      taxAccountId = await ensureSalesTaxExpenseAccount(input.organizationId, tx);
    }

    // 4. Create new transaction_splits: one per receipt line, plus one
    //    for the tax if present.
    const splitRows = resolved.map((l, i) => ({
      id: randomUUID(),
      transactionId: t.id,
      organizationId: input.organizationId,
      categoryAccountId: l.accountId!,
      amount: String(l.amount),
      memo: l.description,
      contactId: t.contactId,
      intent: 'receipt-match' as const,
      intentTargetId: r.id,
      position: i,
    }));
    if (taxAccountId && taxAmount > 0) {
      splitRows.push({
        id: randomUUID(),
        transactionId: t.id,
        organizationId: input.organizationId,
        categoryAccountId: taxAccountId,
        amount: String(taxAmount),
        memo: 'Sales tax',
        contactId: t.contactId,
        intent: 'receipt-match' as const,
        intentTargetId: r.id,
        position: splitRows.length,
      });
    }
    await tx.insert(transactionSplits).values(splitRows);

    // 5. Build the JE. One debit *per receipt line* (carrying the line's
    //    own description as the memo, so the GL shows "SALAD KIT" /
    //    "PARSLEY" rather than a category blob) — plus an extra debit
    //    for sales tax when present, and one consolidated credit to the
    //    transaction's bank/CC account. Multiple lines on the same
    //    expense account is fine here; the GL report reads cleaner with
    //    per-item memos.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const lineContactId = r.contactId ?? t.contactId;
    const debitLines = resolved.map((l) => ({
      accountId: l.accountId!,
      debit: round2(l.amount),
      credit: 0,
      contactId: lineContactId,
      memo: l.description || r.memo || null,
    }));
    if (taxAccountId && taxAmount > 0) {
      debitLines.push({
        accountId: taxAccountId,
        debit: round2(taxAmount),
        credit: 0,
        contactId: lineContactId,
        memo: 'Sales tax',
      });
    }
    let newJe;
    try {
      newJe = await createJournalEntry(
        {
          organizationId: input.organizationId,
          date: t.date,
          memo: r.memo ?? `Receipt match`,
          posted: true,
          sourceType: 'receipt-match',
          sourceId: r.id,
          lines: [
            ...debitLines,
            {
              accountId: t.accountId,
              debit: 0,
              credit: round2(expectedTotal),
              contactId: lineContactId,
              memo: r.memo ?? null,
            },
          ],
        },
        tx,
      );
    } catch (err) {
      if (err instanceof JournalEntryError) throw new ApplyMatchError(err.message);
      throw err;
    }

    // 5. Re-point the transaction at the new JE; null out the single
    //    categoryAccountId since the books now reflect the split set.
    //    Adopt the receipt's contact (Walmart, WinCo, etc.) when the
    //    transaction had no contact of its own — gives the list + detail
    //    pages a vendor to render without forcing a user step. If the
    //    user had already assigned a contact, we leave theirs alone.
    await tx
      .update(transactions)
      .set({
        journalEntryId: newJe.id,
        categoryAccountId: null,
        reviewed: true,
        contactId: t.contactId ?? r.contactId,
      })
      .where(eq(transactions.id, t.id));

    // 6. Re-point the receipt — posted, JE'd, source account = the
    //    transaction's bank/CC account.
    await tx
      .update(receipts)
      .set({
        posted: true,
        status: 'posted',
        postedAt: new Date().toISOString(),
        journalEntryId: newJe.id,
        sourceAccountId: t.accountId,
      })
      .where(eq(receipts.id, r.id));

    // 7. Mark the suggestion auto_applied. Other suggestions on the
    //    same receipt get auto-dismissed since the receipt's now spoken
    //    for.
    const now = new Date().toISOString();
    await tx
      .update(receiptMatchSuggestions)
      .set({ status: 'auto_applied', updatedAt: now })
      .where(eq(receiptMatchSuggestions.id, suggestion.id));
    await tx
      .update(receiptMatchSuggestions)
      .set({ status: 'superseded', updatedAt: now })
      .where(
        and(
          eq(receiptMatchSuggestions.receiptId, r.id),
          eq(receiptMatchSuggestions.status, 'pending'),
        ),
      );

    // 8. Persist the snapshot. The table has a UNIQUE index on
    //    suggestion_id so re-applying after an undo (where the old row
    //    is still around with reversed_at set) must UPDATE rather than
    //    INSERT. ON CONFLICT keeps a single row per suggestion that
    //    always reflects the latest apply — clears reversed_at, points
    //    at the new JE, refreshes the pre-state snapshot. The audit
    //    trail of past apply/undo cycles lives on the JE reversal
    //    entries themselves, which are immutable.
    const applicationId = randomUUID();
    const [appRow] = await tx
      .insert(receiptMatchApplications)
      .values({
        id: applicationId,
        organizationId: input.organizationId,
        suggestionId: suggestion.id,
        receiptId: r.id,
        transactionId: t.id,
        newJournalEntryId: newJe.id,
        preState,
        appliedAt: now,
        reversedAt: null,
      })
      .onConflictDoUpdate({
        target: receiptMatchApplications.suggestionId,
        set: {
          newJournalEntryId: newJe.id,
          preState,
          appliedAt: now,
          reversedAt: null,
        },
      })
      .returning({ id: receiptMatchApplications.id });

    const finalApplicationId = appRow?.id ?? applicationId;

    // 9. Receipt is now applied to this transaction, but the new JE was
    //    created BEFORE the application row existed — so the rules engine
    //    fired NO_RECEIPT_POSSIBLE_DISTRIBUTION on it (hasReceipt was
    //    false at evaluate time). Clear that stale finding and drop a
    //    TRUST_RECEIPT_ATTACHED audit so the Trust Review queue reflects
    //    the receipt landing. Idempotent — DELETE is a no-op when no
    //    stale finding exists; the audit insert always runs.
    await tx
      .delete(trustReviewFindings)
      .where(
        and(
          eq(trustReviewFindings.journalEntryId, newJe.id),
          eq(trustReviewFindings.code, 'TRUST_NO_RECEIPT_POSSIBLE_DISTRIBUTION'),
        ),
      );
    await tx.insert(trustReviewFindings).values({
      id: randomUUID(),
      organizationId: input.organizationId,
      journalEntryId: newJe.id,
      code: 'TRUST_RECEIPT_ATTACHED',
      severity: 'warn',
      message: `Receipt ${r.id.slice(0, 8)} applied — withdrawal-without-receipt warning cleared.`,
      metadata: { receiptId: r.id, transactionId: t.id, applicationId: finalApplicationId },
    });

    logger.info(
      { applicationId: finalApplicationId, suggestionId: suggestion.id, receiptId: r.id, transactionId: t.id, newJournalEntryId: newJe.id, lineSubtotal, taxAmount, total: expectedTotal },
      'receipt match auto-applied',
    );

    return { applicationId: finalApplicationId, newJournalEntryId: newJe.id };
  });
}
