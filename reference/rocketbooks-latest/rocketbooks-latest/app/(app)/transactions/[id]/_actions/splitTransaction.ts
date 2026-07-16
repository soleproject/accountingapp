'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, transactionSplits, contacts, bills, payments, invoices as invoicesTable } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, reverseJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError } from '@/lib/billing/entitlements';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import { resolveApAccountId } from '@/lib/accounting/resolve-ap';
import { resolveArAccountId } from '@/lib/accounting/resolve-ar';

const LineSchema = z.object({
  // Optional — directional-intent lines don't carry a category account
  // (the AP / AR account is resolved server-side and stored on the row).
  categoryAccountId: z.string().optional(),
  amount: z.coerce.number().positive(),
  memo: z.string().max(500).optional(),
  contactId: z.string().min(1).optional(),
  intent: z.enum(['bill_payment', 'invoice_payment']).optional(),
  intentTargetId: z.string().optional(),
});

const InputSchema = z.object({
  lines: z.array(LineSchema).min(2, 'A split needs at least 2 lines'),
  userDescription: z.string().max(500).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  accountId: z.string().min(1).optional(),
  type: z.enum(['deposit', 'withdrawal']).optional(),
});

export interface SplitTransactionState {
  error?: string;
}

/**
 * Replace a transaction's single-category JE with a multi-line split. Each
 * input line gets its own debit (withdrawal) or credit (deposit) line on
 * the new JE; the bank side stays as a single line for the full amount.
 *
 * The categoryAccountId on the transactions row is set to the *first*
 * split line's account so legacy filters (uncategorized = NULL) keep
 * working — but reports drill the JE directly so the split is reflected
 * accurately downstream.
 */
export async function splitTransaction(
  transactionId: string,
  _prev: SplitTransactionState | undefined,
  formData: FormData,
): Promise<SplitTransactionState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  // Pull lines from FormData using the lines[i].* convention. A line is
  // valid if it has EITHER a categoryAccountId (regular) OR intent set
  // (bill_payment) — plus an amount. Lines lacking both keys are treated
  // as the end of the list.
  const lines: unknown[] = [];
  for (let i = 0; ; i++) {
    const acct = formData.get(`lines[${i}].categoryAccountId`);
    const intent = formData.get(`lines[${i}].intent`);
    const amt = formData.get(`lines[${i}].amount`);
    if (acct === null && intent === null && amt === null) break;
    if (!amt) continue;
    if (!acct && !intent) continue;
    lines.push({
      categoryAccountId: acct || undefined,
      amount: amt,
      memo: formData.get(`lines[${i}].memo`) || undefined,
      contactId: formData.get(`lines[${i}].contactId`) || undefined,
      intent: intent || undefined,
      intentTargetId: formData.get(`lines[${i}].intentTargetId`) || undefined,
    });
  }

  const userDescriptionRaw = formData.get('userDescription');
  const dateRaw = formData.get('date');
  const accountIdRaw = formData.get('accountId');
  const typeRaw = formData.get('type');
  const parsed = InputSchema.safeParse({
    lines,
    userDescription: typeof userDescriptionRaw === 'string' ? userDescriptionRaw : undefined,
    date: typeof dateRaw === 'string' && dateRaw ? dateRaw : undefined,
    accountId: typeof accountIdRaw === 'string' && accountIdRaw ? accountIdRaw : undefined,
    type: typeof typeRaw === 'string' && typeRaw ? typeRaw : undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid split lines.' };
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

  const newDate = parsed.data.date ?? txn.date;
  try {
    await requireDateCovered(orgId, newDate);
  } catch (e) {
    if (e instanceof DateNotCoveredError) return { error: e.message };
    throw e;
  }

  const newType = parsed.data.type ?? (txn.type ?? '').toLowerCase();
  if (newType !== 'deposit' && newType !== 'withdrawal') {
    return { error: `Cannot split a ${txn.type} transaction` };
  }

  const newAccountId = parsed.data.accountId ?? txn.accountId;
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

  const total = txn.amount;
  const linesSum = parsed.data.lines.reduce((s, l) => s + l.amount, 0);
  // Allow penny rounding error (multiple lines of e.g. $33.33 won't sum
  // to $100 perfectly).
  if (Math.abs(linesSum - total) > 0.01) {
    return {
      error: `Split lines total ${linesSum.toFixed(2)} but the transaction is ${total.toFixed(2)}.`,
    };
  }

  // Per-line: every regular (non-intent) line must have a valid org account.
  // Directional-intent lines don't carry a category — they target a bill
  // or invoice UUID instead.
  const accountIds = parsed.data.lines
    .filter((l) => !l.intent)
    .map((l) => l.categoryAccountId)
    .filter((v): v is string => !!v);
  const orgAccounts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));
  const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
  if (accountIds.some((id) => !orgAccountIds.has(id))) {
    return { error: 'One or more category accounts not in this organization' };
  }
  // Every regular line must have a category. Directional-intent lines
  // must have an intentTargetId (the bill or invoice UUID).
  for (let i = 0; i < parsed.data.lines.length; i++) {
    const l = parsed.data.lines[i]!;
    if (l.intent === 'bill_payment') {
      if (!l.intentTargetId) {
        return { error: `Line ${i + 1}: bill is required for a bill-payment line` };
      }
    } else if (l.intent === 'invoice_payment') {
      if (!l.intentTargetId) {
        return { error: `Line ${i + 1}: invoice is required for an invoice-payment line` };
      }
    } else if (!l.categoryAccountId) {
      return { error: `Line ${i + 1}: category is required` };
    }
  }

  // Bill-payment line validation: each picked bill must exist in the org,
  // not already be 'paid', and the line amount must fit within the bill's
  // remaining balance. Multiple lines hitting the same bill are summed —
  // we don't allow them to combined-overpay either.
  const billLines = parsed.data.lines.filter((l) => l.intent === 'bill_payment');
  let outstandingByBill = new Map<string, { balance: number; total: number; applied: number; billNumber: string | null; contactId: string | null }>();
  if (billLines.length > 0) {
    if (newType !== 'withdrawal') {
      return { error: 'Only withdrawal transactions can pay a bill' };
    }
    const outstanding = await getOutstandingBills(orgId);
    for (const b of outstanding) {
      outstandingByBill.set(b.id, {
        balance: b.balance,
        total: b.total,
        applied: b.applied,
        billNumber: b.billNumber,
        contactId: b.contactId,
      });
    }
    const requestedByBill = new Map<string, number>();
    for (const l of billLines) {
      const id = l.intentTargetId!;
      requestedByBill.set(id, (requestedByBill.get(id) ?? 0) + l.amount);
    }
    for (const [billId, requested] of requestedByBill) {
      const b = outstandingByBill.get(billId);
      if (!b) return { error: `Bill ${billId.slice(0, 8)} is not outstanding in this organization` };
      if (requested > b.balance + 0.005) {
        return {
          error: `Bill #${b.billNumber ?? billId.slice(0, 8)} balance is $${b.balance.toFixed(2)} but split lines for it total $${requested.toFixed(2)}.`,
        };
      }
    }
  }

  // Invoice-payment line validation: mirror of bills for AR side.
  const invoiceLines = parsed.data.lines.filter((l) => l.intent === 'invoice_payment');
  let outstandingByInvoice = new Map<string, { balance: number; total: number; applied: number; invoiceNumber: string | null; contactId: string | null }>();
  if (invoiceLines.length > 0) {
    if (newType !== 'deposit') {
      return { error: 'Only deposit transactions can be applied to an invoice' };
    }
    const outstanding = await getOutstandingInvoices(orgId);
    for (const i of outstanding) {
      outstandingByInvoice.set(i.id, {
        balance: i.balance,
        total: i.total,
        applied: i.applied,
        invoiceNumber: i.invoiceNumber,
        contactId: i.contactId,
      });
    }
    const requestedByInvoice = new Map<string, number>();
    for (const l of invoiceLines) {
      const id = l.intentTargetId!;
      requestedByInvoice.set(id, (requestedByInvoice.get(id) ?? 0) + l.amount);
    }
    for (const [invoiceId, requested] of requestedByInvoice) {
      const inv = outstandingByInvoice.get(invoiceId);
      if (!inv) return { error: `Invoice ${invoiceId.slice(0, 8)} is not outstanding in this organization` };
      if (requested > inv.balance + 0.005) {
        return {
          error: `Invoice #${inv.invoiceNumber ?? invoiceId.slice(0, 8)} balance is $${inv.balance.toFixed(2)} but split lines for it total $${requested.toFixed(2)}.`,
        };
      }
    }
  }

  // Validate every per-line contact belongs to the org.
  const perLineContactIds = Array.from(
    new Set(parsed.data.lines.map((l) => l.contactId).filter((v): v is string => !!v)),
  );
  if (perLineContactIds.length > 0) {
    const orgContacts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.organizationId, orgId));
    const orgContactIds = new Set(orgContacts.map((c) => c.id));
    if (perLineContactIds.some((id) => !orgContactIds.has(id))) {
      return { error: 'One or more contacts not in this organization' };
    }
  }

  const isDeposit = newType === 'deposit';
  // If the user edited description in split mode, use the new value; otherwise
  // fall back to whatever was already on the txn.
  const newUserDescription =
    parsed.data.userDescription !== undefined
      ? parsed.data.userDescription.trim() || null
      : (txn.userDescription ?? null);
  const memoBase = newUserDescription ?? txn.bankDescription ?? txn.description ?? null;

  // Resolve AP / AR once if directional lines exist — they're the debit /
  // credit targets for those JE rows AND the categoryAccountId we store
  // on the split row (transaction_splits.category_account_id is NOT NULL).
  let apAccountId: string | null = null;
  let arAccountId: string | null = null;
  if (billLines.length > 0) {
    apAccountId = await resolveApAccountId(orgId);
    if (!apAccountId) {
      return { error: 'No Accounts Payable account configured for this org' };
    }
  }
  if (invoiceLines.length > 0) {
    arAccountId = await resolveArAccountId(orgId);
    if (!arAccountId) {
      return { error: 'No Accounts Receivable account configured for this org' };
    }
  }

  // We'll need each line's resolved info — its effective categoryAccountId
  // (AP / AR for directional lines) and a pre-generated split-row id so we
  // can link payments rows by transaction_split_id. Built once here, used
  // inside the transaction below.
  const resolvedLines = parsed.data.lines.map((l) => {
    const isBill = l.intent === 'bill_payment';
    const isInvoice = l.intent === 'invoice_payment';
    const billInfo = isBill ? outstandingByBill.get(l.intentTargetId!) : undefined;
    const invoiceInfo = isInvoice ? outstandingByInvoice.get(l.intentTargetId!) : undefined;
    const resolvedCategoryAccountId = isBill
      ? apAccountId!
      : isInvoice
        ? arAccountId!
        : l.categoryAccountId!;
    const lineContactId =
      l.contactId ?? billInfo?.contactId ?? invoiceInfo?.contactId ?? txn.contactId ?? null;
    return {
      ...l,
      splitId: randomUUID(),
      resolvedCategoryAccountId,
      resolvedContactId: lineContactId,
      billInfo,
      invoiceInfo,
    };
  });

  try {
    await db.transaction(async (tx) => {
      // Reverse the existing JE if there is one.
      if (txn.journalEntryId) {
        await reverseJournalEntry(
          {
            organizationId: orgId,
            journalEntryId: txn.journalEntryId,
            reversalDate: new Date().toISOString().slice(0, 10),
            reversalMemo: `Reversal for split of transaction ${transactionId.slice(0, 8)}`,
          },
          tx,
        );
      }

      // Drop any prior payments rows linked to this txn — covers both the
      // single-mode bill payment case and prior split-line bill payments.
      // They'll be re-inserted below for lines that still have the intent.
      await tx.delete(payments).where(eq(payments.transactionId, transactionId));

      // Build the multi-line JE. Directional lines target AP / AR; regular
      // lines target the picked category. Per-line contact override still
      // wins when set. The JE debit/credit direction is determined by the
      // transaction type, not the intent — AR being credited on a deposit
      // and AP being debited on a withdrawal both fall out naturally.
      const splitJeLines = resolvedLines.map((l) => {
        let lineMemo: string | null = l.memo ?? memoBase;
        if (l.intent === 'bill_payment' && l.billInfo) {
          lineMemo = `Payment for Bill #${l.billInfo.billNumber ?? l.intentTargetId!.slice(0, 8)}`;
        } else if (l.intent === 'invoice_payment' && l.invoiceInfo) {
          lineMemo = `Payment for Invoice #${l.invoiceInfo.invoiceNumber ?? l.intentTargetId!.slice(0, 8)}`;
        }
        return {
          accountId: l.resolvedCategoryAccountId,
          debit: isDeposit ? 0 : l.amount,
          credit: isDeposit ? l.amount : 0,
          contactId: l.resolvedContactId,
          memo: lineMemo,
        };
      });
      const bankLine = {
        accountId: newAccountId!,
        debit: isDeposit ? total : 0,
        credit: isDeposit ? 0 : total,
        contactId: txn.contactId ?? null,
        memo: memoBase,
      };
      const jeLines = isDeposit ? [bankLine, ...splitJeLines] : [...splitJeLines, bankLine];

      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: newDate,
          memo: memoBase ?? `Split ${txn.type}`,
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
          // Track the first split line's resolved category as the "primary"
          // so legacy is-categorized queries still pass. Reports use the
          // JE directly.
          categoryAccountId: resolvedLines[0]!.resolvedCategoryAccountId,
          journalEntryId: je.id,
          reviewed: true,
          userDescription: newUserDescription,
          date: newDate,
          accountId: newAccountId,
          type: newType,
        })
        .where(and(eq(transactions.id, transactionId), eq(transactions.organizationId, orgId)));

      // Replace any prior split rows for this txn with the new ones.
      await tx
        .delete(transactionSplits)
        .where(eq(transactionSplits.transactionId, transactionId));
      await tx.insert(transactionSplits).values(
        resolvedLines.map((l, idx) => ({
          id: l.splitId,
          transactionId,
          organizationId: orgId,
          categoryAccountId: l.resolvedCategoryAccountId,
          amount: l.amount.toFixed(2),
          memo: l.memo ?? null,
          contactId: l.resolvedContactId,
          intent: l.intent ?? null,
          intentTargetId: l.intentTargetId ?? null,
          position: idx,
        })),
      );

      // Bill payments → insert a payments row per bill-payment line, linked
      // back to the originating split row. Then recompute bill balance and
      // mark fully-applied bills 'paid'.
      const billPaymentLines = resolvedLines.filter((l) => l.intent === 'bill_payment');
      if (billPaymentLines.length > 0) {
        await tx.insert(payments).values(
          billPaymentLines.map((l) => ({
            id: randomUUID(),
            organizationId: orgId,
            type: 'sent',
            paymentDate: newDate,
            amount: l.amount,
            vendorId: l.billInfo?.contactId ?? null,
            billId: l.intentTargetId!,
            apAccountId: apAccountId!,
            bankAccountId: newAccountId,
            journalEntryId: je.id,
            transactionId,
            transactionSplitId: l.splitId,
          })),
        );

        const sumByBill = new Map<string, number>();
        for (const l of billPaymentLines) {
          sumByBill.set(l.intentTargetId!, (sumByBill.get(l.intentTargetId!) ?? 0) + l.amount);
        }
        for (const [billId, addedAmount] of sumByBill) {
          const b = outstandingByBill.get(billId);
          if (!b) continue;
          const newApplied = b.applied + addedAmount;
          if (newApplied + 0.005 >= b.total) {
            await tx.update(bills).set({ status: 'paid' }).where(eq(bills.id, billId));
          }
        }
      }

      // Invoice payments → mirror of the bill flow for AR side.
      const invoicePaymentLines = resolvedLines.filter((l) => l.intent === 'invoice_payment');
      if (invoicePaymentLines.length > 0) {
        await tx.insert(payments).values(
          invoicePaymentLines.map((l) => ({
            id: randomUUID(),
            organizationId: orgId,
            type: 'received',
            paymentDate: newDate,
            amount: l.amount,
            customerId: l.invoiceInfo?.contactId ?? null,
            invoiceId: l.intentTargetId!,
            arAccountId: arAccountId!,
            bankAccountId: newAccountId,
            journalEntryId: je.id,
            transactionId,
            transactionSplitId: l.splitId,
          })),
        );

        const sumByInvoice = new Map<string, number>();
        for (const l of invoicePaymentLines) {
          sumByInvoice.set(l.intentTargetId!, (sumByInvoice.get(l.intentTargetId!) ?? 0) + l.amount);
        }
        for (const [invoiceId, addedAmount] of sumByInvoice) {
          const inv = outstandingByInvoice.get(invoiceId);
          if (!inv) continue;
          const newApplied = inv.applied + addedAmount;
          if (newApplied + 0.005 >= inv.total) {
            await tx
              .update(invoicesTable)
              .set({ status: 'paid' })
              .where(eq(invoicesTable.id, invoiceId));
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  // Best-effort draft-receipt match check on update — picks up the
  // case where a receipt was uploaded before the txn got categorized.
  try {
    const { findReceiptMatchesForTransaction } = await import('@/lib/receipts/find-receipt-matches-for-transaction');
    await findReceiptMatchesForTransaction({ organizationId: orgId, transactionId });
  } catch {}

  revalidatePath('/transactions');
  revalidatePath(`/transactions/${transactionId}`);
  if (parsed.data.lines.some((l) => l.intent === 'bill_payment')) {
    revalidatePath('/bills');
  }
  if (parsed.data.lines.some((l) => l.intent === 'invoice_payment')) {
    revalidatePath('/invoices');
  }
  redirect(`/transactions/${transactionId}`);
}
