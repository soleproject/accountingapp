'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, bills, payments, invoices as invoicesTable, trustBeneficiaries, trustReviewFindings } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntryFromTransaction, repostTransactionJE } from '@/lib/accounting/auto-post';
import { findOrCreateContact } from '@/lib/accounting/ensure-contact';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { maybeRerouteFor815820, buildRerouteFinding } from '@/lib/accounting/trust-reroute';
import { maybeAutoLinkLoanPayment } from '@/lib/loans/auto-match';
import { maybeAutoTagFromMemory } from '@/lib/accounting/tag-from-memory';
import { safeSend } from '@/lib/inngest';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError } from '@/lib/billing/entitlements';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { resolveApAccountId } from '@/lib/accounting/resolve-ap';
import { resolveArAccountId } from '@/lib/accounting/resolve-ar';
import { recordFirmChange } from '@/lib/enterprise/attribution';

const Schema = z.object({
  transactionId: z.string().min(1),
  // Optional at the schema layer because bill_payment intent doesn't carry
  // a category account — the AP account is resolved server-side. Each
  // branch enforces its own required-ness below.
  categoryAccountId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  userDescription: z.string().max(500).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  accountId: z.string().min(1).optional(),
  type: z.enum(['deposit', 'withdrawal']).optional(),
  intent: z.enum(['bill_payment', 'invoice_payment']).optional(),
  intentTargetId: z.string().optional().nullable(),
  // Phase 4d: per-line beneficiary tag. Required at this action when the
  // chosen category is a per-beneficiary account on a trust org. The block
  // below resolves + validates after the category lookup.
  beneficiaryId: z.string().optional().nullable(),
});

/**
 * Detail-type slugs that REQUIRE a beneficiary tag on trust orgs. Matches
 * the per-line gate in lib/accounting/rules/beneficial-trust/eligibility.ts.
 */
const PER_BENEFICIARY_DETAIL_TYPES = new Set<string>([
  'trust_food_minors_incapacitated',
  'trust_clothing_minors_incapacitated',
  'trust_distributions_to_beneficiaries',
  'trust_medical_wellness',
]);

export interface CategorizeState {
  error?: string;
  ok?: boolean;
  /** Number of OTHER uncategorized transactions in the org that share this merchant */
  matchingUncategorizedCount?: number;
  /** First ~200 matching uncategorized IDs — to apply the same category to in bulk */
  matchingTransactionIds?: string[];
  /** The merchant string we matched on (for the prompt UI) */
  merchantLabel?: string | null;
  /** The category just applied — for the bulk apply UI */
  appliedCategoryAccountId?: string;
  /** The contact just applied — for the bulk apply UI */
  appliedContactId?: string | null;
  /** Directional overpayment — the picked bill/invoice balance is less
   *  than the transaction amount. UI can offer a "Split for me" affordance
   *  that pre-fills a 2-line split (target amount + remainder). */
  overpayment?: {
    intent: 'bill_payment' | 'invoice_payment';
    targetId: string;
    targetLabel: string;
    targetBalance: number;
    txnAmount: number;
    remaining: number;
  };
}

export async function categorizeTransaction(
  _prev: CategorizeState | undefined,
  formData: FormData,
): Promise<CategorizeState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  const parsed = Schema.safeParse({
    transactionId: formData.get('transactionId'),
    categoryAccountId: formData.get('categoryAccountId') || null,
    contactId: formData.get('contactId') || null,
    userDescription: formData.get('userDescription') || null,
    date: formData.get('date') || undefined,
    accountId: formData.get('accountId') || undefined,
    type: formData.get('type') || undefined,
    intent: formData.get('intent') || undefined,
    intentTargetId: formData.get('intentTargetId') || null,
    beneficiaryId: formData.get('beneficiaryId') || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };

  const [txn] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, parsed.data.transactionId), eq(transactions.organizationId, orgId)))
    .limit(1);
  if (!txn) return { error: 'Transaction not found in this organization' };

  // ─── Bill-payment branch ───────────────────────────────────────────────
  // Picker emitted intent=bill_payment + the bill UUID. We post a JE
  // (debit AP, credit txn.accountId) and insert a payments row linked back
  // to the transaction, instead of the normal category posting.
  if (parsed.data.intent === 'bill_payment') {
    return await handleBillPayment({
      orgId,
      txn,
      billId: parsed.data.intentTargetId ?? '',
      userDescription: parsed.data.userDescription ?? null,
      date: parsed.data.date,
    });
  }

  // ─── Invoice-payment branch ────────────────────────────────────────────
  // Mirror of bill payment for deposits: debit txn.accountId, credit AR.
  if (parsed.data.intent === 'invoice_payment') {
    return await handleInvoicePayment({
      orgId,
      txn,
      invoiceId: parsed.data.intentTargetId ?? '',
      userDescription: parsed.data.userDescription ?? null,
      date: parsed.data.date,
    });
  }

  // Regular-category branch — require categoryAccountId.
  if (!parsed.data.categoryAccountId) {
    return { error: 'Category account is required' };
  }
  const [account] = await db
    .select({ id: chartOfAccounts.id, detailType: chartOfAccounts.detailType })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.id, parsed.data.categoryAccountId), eq(chartOfAccounts.organizationId, orgId)))
    .limit(1);
  if (!account) return { error: 'Category account not in this organization' };

  // Phase 4d: per-beneficiary linkage gate. Only applies on trust orgs
  // when the chosen category is a per-beneficiary account.
  let resolvedBeneficiaryId: string | null = parsed.data.beneficiaryId ?? null;
  const requiresBeneficiary =
    !!account.detailType && PER_BENEFICIARY_DETAIL_TYPES.has(account.detailType);
  if (requiresBeneficiary) {
    const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');
    if (trustEnabled) {
      if (!resolvedBeneficiaryId) {
        return { error: 'This account requires you to tag a beneficiary before posting.' };
      }
      const [bene] = await db
        .select({
          id: trustBeneficiaries.id,
          fullName: trustBeneficiaries.fullName,
          dateOfBirth: trustBeneficiaries.dateOfBirth,
          isIncapacitated: trustBeneficiaries.isIncapacitated,
        })
        .from(trustBeneficiaries)
        .where(
          and(
            eq(trustBeneficiaries.id, resolvedBeneficiaryId),
            eq(trustBeneficiaries.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!bene) {
        return { error: 'Selected beneficiary is not part of this organization.' };
      }
      // 815/820 with a non-qualifying beneficiary used to block. Per spec
      // we now REROUTE the posting to the beneficiary's demand-note (26x)
      // account so it books as a non-qualifying advance instead — the
      // reroute is handled below right before posting via
      // maybeRerouteFor815820.
    } else {
      // Non-trust org chose a trust-only account somehow — keep the tag if
      // present but don't enforce. Edge case; shouldn't happen in practice.
      resolvedBeneficiaryId = null;
    }
  } else {
    // Non-per-beneficiary account: ignore any stray tag.
    resolvedBeneficiaryId = null;
  }

  // If the txn was previously a bill payment, clean up the payments row.
  // The JE reversal/repost below handles the GL side; we just need to drop
  // the bill-payment record so the bill's balance recomputes correctly.
  await db.delete(payments).where(eq(payments.transactionId, txn.id));

  if (txn.amount == null) return { error: 'Transaction has no amount' };
  if (!txn.type) return { error: 'Transaction has no type' };
  if (!txn.accountId) return { error: 'Transaction has no bank account' };

  try {
    // If user didn't pick a contact and the txn doesn't already have one,
    // auto-create from the merchant string.
    let resolvedContactId = parsed.data.contactId ?? txn.contactId ?? null;
    if (!resolvedContactId) {
      resolvedContactId = await findOrCreateContact({
        organizationId: orgId,
        merchantName: txn.bankDescription ?? txn.description,
        type: txn.type,
      });
    }

    // Repost the JE on any change that affects accounting integrity:
    //   - category swap → different account on the GL
    //   - contact swap → different contact_id on each JE line + GL row
    //   - date swap → JE date shifts the GL period the txn lands in
    //   - bank account swap → different bank-side account
    //   - type swap → flips debit/credit direction on every line
    // userDescription is a memo change; we update it on the transaction row
    // but don't repost the JE for it.
    const newDate = parsed.data.date ?? txn.date;
    const newAccountId = parsed.data.accountId ?? txn.accountId;
    const newType = parsed.data.type ?? txn.type;
    if (newDate !== txn.date) {
      try {
        await requireDateCovered(orgId, newDate);
      } catch (e) {
        if (e instanceof DateNotCoveredError) return { error: e.message };
        throw e;
      }
    }
    if (parsed.data.accountId && parsed.data.accountId !== txn.accountId) {
      const [bankAcct] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.id, parsed.data.accountId),
            eq(chartOfAccounts.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!bankAcct) return { error: 'Bank account not in this organization' };
    }
    const categoryChanged = txn.categoryAccountId !== parsed.data.categoryAccountId;
    const contactChanged = (txn.contactId ?? null) !== resolvedContactId;
    const dateChanged = newDate !== txn.date;
    const accountChanged = newAccountId !== txn.accountId;
    const typeChanged = newType !== txn.type;
    const needsRepost =
      categoryChanged || contactChanged || dateChanged || accountChanged || typeChanged;

    // Trust 815/820 reroute: if the picked category requires a qualifying
    // beneficiary and the tagged one doesn't qualify, rewrite the post to
    // that beneficiary's demand-note account. The rewrite happens BEFORE
    // the JE creation so the GL shows the demand-note line directly.
    const rerouteResult = await maybeRerouteFor815820({
      organizationId: orgId,
      categoryAccountId: parsed.data.categoryAccountId,
      beneficiaryId: resolvedBeneficiaryId,
      date: newDate,
    });
    const finalCategoryAccountId = rerouteResult.categoryAccountId;

    const updates: Partial<typeof transactions.$inferInsert> = {
      categoryAccountId: finalCategoryAccountId,
      contactId: resolvedContactId,
      userDescription: parsed.data.userDescription ?? txn.userDescription,
      date: newDate,
      accountId: newAccountId,
      type: newType,
      reviewed: true,
    };

    const txnForPosting = {
      id: txn.id,
      organizationId: orgId,
      date: newDate,
      type: newType,
      amount: txn.amount,
      accountId: newAccountId,
      categoryAccountId: finalCategoryAccountId,
      contactId: resolvedContactId,
      bankDescription: txn.bankDescription,
      userDescription: parsed.data.userDescription ?? txn.userDescription,
      beneficiaryId: resolvedBeneficiaryId,
    };

    let postedJeId: string | null = null;
    if (!txn.journalEntryId) {
      // No prior post → just create the JE.
      postedJeId = await createJournalEntryFromTransaction(txnForPosting);
      updates.journalEntryId = postedJeId;
    } else if (needsRepost) {
      // Already posted but a posting-relevant field changed → reverse the
      // prior JE and post a new one. repostTransactionJE handles the
      // journal_entry_id pointer atomically inside its own transaction; we
      // don't add it to `updates` here to avoid double-writing the column.
      const r = await repostTransactionJE({ txn: txnForPosting, existingJournalEntryId: txn.journalEntryId });
      postedJeId = r.replacementId;
    } else {
      postedJeId = txn.journalEntryId;
    }
    // else: nothing posting-relevant changed — JE is still correct.

    await db.update(transactions).set(updates).where(eq(transactions.id, txn.id));

    // Loan auto-match: when the categorized line landed on an active
    // loan's liability account, try to match the bank amount + date to
    // the loan's next unposted schedule row within tolerance. On a
    // match this reverses the simple JE and reposts as a proper 3-line
    // P/I/bank entry; the schedule row gets marked posted. On no-match
    // it does nothing (the rules engine's TRUST_DEFERRED_LOAN_SPLIT_NEEDED
    // finding fires on the original simple JE and the user resolves
    // manually via the per-row Link to loan picker).
    if (postedJeId && finalCategoryAccountId) {
      await maybeAutoLinkLoanPayment({
        organizationId: orgId,
        journalEntryId: postedJeId,
        transactionId: txn.id,
        transactionAmount: Math.abs(Number(txn.amount)),
        transactionDate: newDate,
        bankAccountId: newAccountId,
        categoryAccountId: finalCategoryAccountId,
      });

      // Auto-tag from memory: if a prior transaction with the same
      // vendor, account, and amount was tagged to a rental property /
      // asset, apply that tag here (exact) or surface a suggestion
      // finding (within ±5%). Skipped silently when no memory exists
      // unless the account is property-relevant — in which case it
      // fires an "untagged" finding so the user gets pushed to tag.
      await maybeAutoTagFromMemory({
        organizationId: orgId,
        transactionId: txn.id,
        journalEntryId: postedJeId,
        bankAccountId: newAccountId,
        categoryAccountId: finalCategoryAccountId,
        contactId: resolvedContactId,
        amount: Math.abs(Number(txn.amount)),
        description: txn.bankDescription ?? txn.description,
      });
    }

    // Surface the reroute as a Trust Review finding so it's visible in the
    // queue. The rule engine never sees the original 815/820 intent (we
    // rewrote before posting) so this finding is inserted directly. Per
    // (je_id, code) dedupe — re-saving the same txn won't pile up rows.
    if (postedJeId && rerouteResult.reroute) {
      const finding = buildRerouteFinding({
        organizationId: orgId,
        journalEntryId: postedJeId,
        reroute: rerouteResult.reroute,
      });
      const [existing] = await db
        .select({ id: trustReviewFindings.id })
        .from(trustReviewFindings)
        .where(
          and(
            eq(trustReviewFindings.journalEntryId, postedJeId),
            eq(trustReviewFindings.code, finding.code),
          ),
        )
        .limit(1);
      if (!existing) {
        await db.insert(trustReviewFindings).values({
          id: randomUUID(),
          ...finding,
        });
      }
    }

    // After success: find OTHER uncategorized transactions in this org with the same merchant
    const merchantLabel = txn.bankDescription ?? txn.description ?? null;
    let matchingTransactionIds: string[] = [];
    if (merchantLabel && merchantLabel.trim()) {
      const desc = merchantLabel.trim();
      const matches = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.organizationId, orgId),
            ne(transactions.id, txn.id),
            isNull(transactions.journalEntryId),
            sql`(${transactions.bankDescription} = ${desc} OR ${transactions.description} = ${desc})`,
          ),
        )
        .limit(200);
      matchingTransactionIds = matches.map((m) => m.id);
    }

    // Re-check for draft receipts that now match this transaction —
    // e.g. a Plaid txn that came in before its corresponding receipt was
    // uploaded. Best-effort, swallows on failure.
    try {
      const { findReceiptMatchesForTransaction } = await import('@/lib/receipts/find-receipt-matches-for-transaction');
      await findReceiptMatchesForTransaction({ organizationId: orgId, transactionId: txn.id });
    } catch {}

    await recordFirmChange({
      action: 'categorize',
      orgId,
      entityType: 'transaction',
      entityId: txn.id,
      summary: `Categorized ${merchantLabel ?? 'a transaction'}`,
    });
    revalidatePath('/transactions');
    revalidatePath(`/transactions/${txn.id}`);
    return {
      ok: true,
      matchingUncategorizedCount: matchingTransactionIds.length,
      matchingTransactionIds,
      merchantLabel,
      appliedCategoryAccountId: parsed.data.categoryAccountId,
      appliedContactId: parsed.data.contactId ?? txn.contactId ?? null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to categorize' };
  }
}

interface BillPaymentArgs {
  orgId: string;
  txn: typeof transactions.$inferSelect;
  billId: string;
  userDescription: string | null;
  date: string | undefined;
}

/**
 * Apply a bank transaction as a payment against a specific bill. Posts a
 * JE (debit AP, credit the bank account the txn came from), inserts a
 * payments row linked to the transaction, and marks the bill 'paid' if
 * fully applied.
 *
 * Differs from createPayment() in app/(app)/payments: createPayment posts
 * its own bank line in a brand-new JE. This function uses the EXISTING
 * bank transaction as the bank side — there's no duplicate bank movement.
 */
async function handleBillPayment(
  args: BillPaymentArgs,
): Promise<CategorizeState | undefined> {
  const { orgId, txn, billId, userDescription, date } = args;

  if (!billId) return { error: 'No bill selected for bill_payment intent' };
  if (txn.amount == null) return { error: 'Transaction has no amount' };
  if (!txn.type) return { error: 'Transaction has no type' };
  if (!txn.accountId) return { error: 'Transaction has no bank account' };
  if (txn.type.toLowerCase() !== 'withdrawal') {
    return { error: 'Only withdrawal transactions can pay a bill' };
  }

  const [bill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.id, billId), eq(bills.organizationId, orgId)))
    .limit(1);
  if (!bill) return { error: 'Bill not in this organization' };
  if (bill.status === 'paid') return { error: 'Bill is already paid' };
  if (!bill.contactId) return { error: 'Bill has no vendor' };

  const outstanding = await getOutstandingBills(orgId);
  const billRow = outstanding.find((b) => b.id === billId);
  if (!billRow || billRow.balance <= 0) {
    return { error: 'Bill has no outstanding balance' };
  }

  // Overpayment guard. UI uses this state shape to offer "Split for me".
  if (txn.amount > billRow.balance + 0.005) {
    const billLabel = `Bill #${bill.billNumber ?? bill.id.slice(0, 8)}`;
    return {
      error: `${billLabel} balance is $${billRow.balance.toFixed(2)} but transaction is $${txn.amount.toFixed(2)}. Split the transaction to apply the bill amount here and categorize the remainder.`,
      overpayment: {
        intent: 'bill_payment',
        targetId: bill.id,
        targetLabel: billLabel,
        targetBalance: billRow.balance,
        txnAmount: txn.amount,
        remaining: Math.round((txn.amount - billRow.balance) * 100) / 100,
      },
    };
  }

  const apAccountId = await resolveApAccountId(orgId);
  if (!apAccountId) {
    return { error: 'No Accounts Payable account configured for this org' };
  }

  const newDate = date ?? txn.date;
  if (newDate !== txn.date) {
    try {
      await requireDateCovered(orgId, newDate);
    } catch (e) {
      if (e instanceof DateNotCoveredError) return { error: e.message };
      throw e;
    }
  }

  const memo = `Payment for Bill #${bill.billNumber ?? bill.id.slice(0, 8)}`;
  const paymentId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      // Drop any prior payments row for this transaction (re-categorize case).
      await tx.delete(payments).where(eq(payments.transactionId, txn.id));

      // Reverse the prior JE (regular categorization or older bill payment).
      if (txn.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: txn.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal for bill-payment recategorize of ${txn.id.slice(0, 8)}`,
          },
          tx,
        );
      }

      // New JE: debit AP, credit bank. txn.amount is positive — the bank
      // movement direction comes from withdrawal type, which we asserted
      // above.
      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: newDate,
          memo,
          posted: true,
          sourceType: 'transaction',
          sourceId: txn.id,
          lines: [
            {
              accountId: apAccountId,
              debit: txn.amount!,
              credit: 0,
              contactId: bill.contactId,
              memo,
            },
            {
              accountId: txn.accountId!,
              debit: 0,
              credit: txn.amount!,
              contactId: bill.contactId,
              memo,
            },
          ],
        },
        tx,
      );

      await tx.insert(payments).values({
        id: paymentId,
        organizationId: orgId,
        type: 'sent',
        paymentDate: newDate,
        amount: txn.amount!,
        vendorId: bill.contactId,
        billId: bill.id,
        apAccountId,
        bankAccountId: txn.accountId,
        journalEntryId: je.id,
        transactionId: txn.id,
      });

      await tx
        .update(transactions)
        .set({
          // Set categoryAccountId to the AP account so legacy "uncategorized
          // = null" filters still treat this txn as categorized. Reports
          // that walk the JE / payments row see the bill linkage directly.
          categoryAccountId: apAccountId,
          contactId: bill.contactId,
          userDescription: userDescription ?? txn.userDescription,
          journalEntryId: je.id,
          date: newDate,
          reviewed: true,
        })
        .where(eq(transactions.id, txn.id));

      // Mark bill paid if this payment closes the balance.
      const newApplied = (billRow.applied ?? 0) + txn.amount!;
      if (newApplied + 0.005 >= billRow.total) {
        await tx
          .update(bills)
          .set({ status: 'paid' })
          .where(eq(bills.id, bill.id));
      }
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await recordFirmChange({ action: 'bill_payment', orgId, entityType: 'transaction', entityId: txn.id, summary: `Applied a payment to Bill #${bill.billNumber ?? bill.id.slice(0, 8)}` });
  revalidatePath('/transactions');
  revalidatePath(`/transactions/${txn.id}`);
  revalidatePath('/bills');
  revalidatePath(`/bills/${bill.id}`);
  return {
    ok: true,
    appliedCategoryAccountId: apAccountId,
    appliedContactId: bill.contactId,
  };
}

interface InvoicePaymentArgs {
  orgId: string;
  txn: typeof transactions.$inferSelect;
  invoiceId: string;
  userDescription: string | null;
  date: string | undefined;
}

/**
 * Apply a deposit transaction as a payment against a specific invoice.
 * Posts a JE (debit txn.accountId, credit AR), inserts a payments row
 * (type='received') linked to the transaction, and marks the invoice
 * 'paid' if fully applied. Mirror of handleBillPayment for the AR side.
 */
async function handleInvoicePayment(
  args: InvoicePaymentArgs,
): Promise<CategorizeState | undefined> {
  const { orgId, txn, invoiceId, userDescription, date } = args;

  if (!invoiceId) return { error: 'No invoice selected for invoice_payment intent' };
  if (txn.amount == null) return { error: 'Transaction has no amount' };
  if (!txn.type) return { error: 'Transaction has no type' };
  if (!txn.accountId) return { error: 'Transaction has no bank account' };
  if (txn.type.toLowerCase() !== 'deposit') {
    return { error: 'Only deposit transactions can pay an invoice' };
  }

  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.organizationId, orgId)))
    .limit(1);
  if (!invoice) return { error: 'Invoice not in this organization' };
  if (invoice.status === 'paid') return { error: 'Invoice is already paid' };
  if (!invoice.contactId) return { error: 'Invoice has no customer' };

  const outstanding = await getOutstandingInvoices(orgId);
  const invRow = outstanding.find((i) => i.id === invoiceId);
  if (!invRow || invRow.balance <= 0) {
    return { error: 'Invoice has no outstanding balance' };
  }

  // Overpayment guard. UI uses this state shape to offer "Split for me".
  if (txn.amount > invRow.balance + 0.005) {
    const invoiceLabel = `Invoice #${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`;
    return {
      error: `${invoiceLabel} balance is $${invRow.balance.toFixed(2)} but transaction is $${txn.amount.toFixed(2)}. Split the transaction to apply the invoice amount here and categorize the remainder.`,
      overpayment: {
        intent: 'invoice_payment',
        targetId: invoice.id,
        targetLabel: invoiceLabel,
        targetBalance: invRow.balance,
        txnAmount: txn.amount,
        remaining: Math.round((txn.amount - invRow.balance) * 100) / 100,
      },
    };
  }

  const arAccountId = await resolveArAccountId(orgId);
  if (!arAccountId) {
    return { error: 'No Accounts Receivable account configured for this org' };
  }

  const newDate = date ?? txn.date;
  if (newDate !== txn.date) {
    try {
      await requireDateCovered(orgId, newDate);
    } catch (e) {
      if (e instanceof DateNotCoveredError) return { error: e.message };
      throw e;
    }
  }

  const memo = `Payment for Invoice #${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`;
  const paymentId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      await tx.delete(payments).where(eq(payments.transactionId, txn.id));

      if (txn.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: txn.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal for invoice-payment recategorize of ${txn.id.slice(0, 8)}`,
          },
          tx,
        );
      }

      // New JE for a received payment: debit bank, credit AR.
      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: newDate,
          memo,
          posted: true,
          sourceType: 'transaction',
          sourceId: txn.id,
          lines: [
            {
              accountId: txn.accountId!,
              debit: txn.amount!,
              credit: 0,
              contactId: invoice.contactId,
              memo,
            },
            {
              accountId: arAccountId,
              debit: 0,
              credit: txn.amount!,
              contactId: invoice.contactId,
              memo,
            },
          ],
        },
        tx,
      );

      await tx.insert(payments).values({
        id: paymentId,
        organizationId: orgId,
        type: 'received',
        paymentDate: newDate,
        amount: txn.amount!,
        customerId: invoice.contactId,
        invoiceId: invoice.id,
        arAccountId,
        bankAccountId: txn.accountId,
        journalEntryId: je.id,
        transactionId: txn.id,
      });

      await tx
        .update(transactions)
        .set({
          categoryAccountId: arAccountId,
          contactId: invoice.contactId,
          userDescription: userDescription ?? txn.userDescription,
          journalEntryId: je.id,
          date: newDate,
          reviewed: true,
        })
        .where(eq(transactions.id, txn.id));

      const newApplied = (invRow.applied ?? 0) + txn.amount!;
      if (newApplied + 0.005 >= invRow.total) {
        await tx
          .update(invoicesTable)
          .set({ status: 'paid' })
          .where(eq(invoicesTable.id, invoice.id));
      }
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await recordFirmChange({ action: 'invoice_payment', orgId, entityType: 'transaction', entityId: txn.id, summary: `Applied a payment to Invoice #${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}` });
  revalidatePath('/transactions');
  revalidatePath(`/transactions/${txn.id}`);
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  return {
    ok: true,
    appliedCategoryAccountId: arAccountId,
    appliedContactId: invoice.contactId,
  };
}

const ApplyMatchingSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  categoryAccountId: z.string().min(1),
  contactId: z.string().optional().nullable(),
});

export interface ApplyMatchingState { ok?: boolean; queued?: number; error?: string; }

export async function applyToMatchingAction(
  _prev: ApplyMatchingState | undefined,
  formData: FormData,
): Promise<ApplyMatchingState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }
  const parsed = ApplyMatchingSchema.safeParse({
    ids: formData.getAll('ids').map(String).filter(Boolean),
    categoryAccountId: formData.get('categoryAccountId'),
    contactId: formData.get('contactId') || null,
  });
  if (!parsed.success) return { error: 'Invalid input' };

  // Pre-set the same category + contact on all the matching transactions so
  // when auto-categorize hits them, vendor memory will already match. But we
  // also dispatch the auto-categorize event directly so it actually posts JEs.
  // Setting categoryAccountId without journalEntryId leaves them in an
  // intermediate state that the auto-categorize fn handles correctly.
  for (const id of parsed.data.ids) {
    await db
      .update(transactions)
      .set({
        categoryAccountId: parsed.data.categoryAccountId,
        contactId: parsed.data.contactId ?? undefined,
      })
      .where(and(eq(transactions.id, id), eq(transactions.organizationId, orgId)));
  }

  const queued = await safeSend({
    name: 'transactions/auto-categorize.requested',
    data: { organizationId: orgId, transactionIds: parsed.data.ids },
  });

  revalidatePath('/transactions');
  return queued
    ? { ok: true, queued: parsed.data.ids.length }
    : { ok: true, queued: 0, error: 'Background queue unavailable; transactions tagged but not yet posted' };
}
