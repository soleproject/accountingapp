'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  transactions,
  contacts,
  chartOfAccounts,
  transactionSplits,
  bills,
  invoices,
  payments,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError, buildUnlockCta } from '@/lib/billing/entitlements';
import { resolveApAccountId } from '@/lib/accounting/resolve-ap';
import { resolveArAccountId } from '@/lib/accounting/resolve-ar';
import { getOutstandingBills } from '@/lib/accounting/bills-outstanding';
import { getOutstandingInvoices } from '@/lib/accounting/invoices-outstanding';
import type { CreateManualTransactionState } from './createManualTransaction';

const LineSchema = z
  .object({
    type: z.enum(['deposit', 'withdrawal']),
    // Optional — directional-intent lines don't carry a category account
    // (AP / AR is resolved server-side).
    categoryAccountId: z.string().optional(),
    amount: z.coerce.number().positive(),
    memo: z.string().max(500).optional(),
    contactId: z.string().min(1).optional(),
    intent: z.enum(['bill_payment', 'invoice_payment']).optional(),
    intentTargetId: z.string().optional(),
  })
  .refine((l) => !!l.categoryAccountId || !!l.intent, {
    message: 'Each line needs a category or a bill/invoice intent',
  });

const InputSchema = z.object({
  type: z.enum(['deposit', 'withdrawal']),
  date: z.iso.date(),
  amount: z.coerce.number().positive(),
  bankAccountId: z.string().min(1),
  contactId: z.string().optional(),
  description: z.string().max(500).optional(),
  lines: z.array(LineSchema).min(2, 'A split needs at least 2 lines'),
});

/**
 * Create a manual transaction with split lines that may mix directions.
 *
 * The per-line `type` lets a single txn model real-world flows like a
 * rental deposit netting management fees: one deposit-type line credits
 * AR (invoice cleared) and one withdrawal-type line debits AP (bill
 * cleared). The bank account gets the net of inflows minus outflows.
 *
 * JE construction:
 *   - Deposit-type lines → credit the line's account (the user-picked
 *     category, or the resolved AR account for an invoice_payment).
 *   - Withdrawal-type lines → debit the line's account (or resolved AP
 *     for a bill_payment).
 *   - Bank line: debited when net inflow > 0 (overall deposit), credited
 *     when net inflow < 0 (overall withdrawal). Magnitude = |net|.
 *
 * The overall txn.type / txn.amount on the form must match the signed
 * net so the resulting bank line direction lines up with what the user
 * picked at the top of the form. The form computes/validates this
 * client-side and the server re-checks.
 */
export async function createSplitManualTransaction(
  _prev: CreateManualTransactionState | undefined,
  formData: FormData,
): Promise<CreateManualTransactionState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }

  // Pull lines using the lines[i].* convention.
  const lines: unknown[] = [];
  for (let i = 0; ; i++) {
    const lineType = formData.get(`lines[${i}].type`);
    const acct = formData.get(`lines[${i}].categoryAccountId`);
    const amt = formData.get(`lines[${i}].amount`);
    const intent = formData.get(`lines[${i}].intent`);
    if (lineType === null && acct === null && amt === null && intent === null) break;
    if (!amt) continue;
    if (!acct && !intent) continue;
    lines.push({
      type: lineType ?? undefined,
      categoryAccountId: acct || undefined,
      amount: amt,
      memo: formData.get(`lines[${i}].memo`) || undefined,
      contactId: formData.get(`lines[${i}].contactId`) || undefined,
      intent: intent || undefined,
      intentTargetId: formData.get(`lines[${i}].intentTargetId`) || undefined,
    });
  }

  const parsed = InputSchema.safeParse({
    type: formData.get('type'),
    date: formData.get('date'),
    amount: formData.get('amount'),
    bankAccountId: formData.get('bankAccountId'),
    contactId: formData.get('contactId') || undefined,
    description: formData.get('description') || undefined,
    lines,
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }

  // The signed net (inflows − outflows) must equal the signed txn amount
  // (positive for deposit, negative for withdrawal) so the bank line
  // direction matches the top-level type.
  const inflow = parsed.data.lines
    .filter((l) => l.type === 'deposit')
    .reduce((s, l) => s + l.amount, 0);
  const outflow = parsed.data.lines
    .filter((l) => l.type === 'withdrawal')
    .reduce((s, l) => s + l.amount, 0);
  const net = Math.round((inflow - outflow) * 100) / 100;
  const signedAmount =
    Math.round((parsed.data.type === 'deposit' ? 1 : -1) * parsed.data.amount * 100) / 100;
  if (net !== signedAmount) {
    return {
      error: `Split lines net to ${net >= 0 ? '+' : ''}${net.toFixed(2)} but the transaction is ${
        signedAmount >= 0 ? '+' : ''
      }${signedAmount.toFixed(2)}. Adjust the split lines or the top-level type.`,
    };
  }

  try {
    await requireDateCovered(orgId, parsed.data.date);
  } catch (e) {
    if (e instanceof DateNotCoveredError) {
      return { error: e.message, ...(await buildUnlockCta(e)) };
    }
    throw e;
  }

  // Validate every plain category + bank account belongs to the org.
  const accountIds = Array.from(
    new Set([
      parsed.data.bankAccountId,
      ...parsed.data.lines
        .map((l) => l.categoryAccountId)
        .filter((v): v is string => !!v),
    ]),
  );
  const orgAccounts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(inArray(chartOfAccounts.id, accountIds));
  const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
  if (accountIds.some((id) => !orgAccountIds.has(id))) {
    return { error: 'One or more accounts not in this organization' };
  }

  // Validate contacts.
  const contactIds = Array.from(
    new Set(
      [
        parsed.data.contactId,
        ...parsed.data.lines.map((l) => l.contactId).filter((v): v is string => !!v),
      ].filter((v): v is string => !!v),
    ),
  );
  if (contactIds.length > 0) {
    const orgContacts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));
    const orgContactIds = new Set(orgContacts.map((c) => c.id));
    if (contactIds.some((id) => !orgContactIds.has(id))) {
      return { error: 'One or more contacts not in this organization' };
    }
  }

  // Validate intent targets against outstanding bills / invoices and
  // make sure each line's amount fits inside the remaining balance.
  const billLineEntries = parsed.data.lines
    .map((l, idx) => ({ l, idx }))
    .filter(({ l }) => l.intent === 'bill_payment');
  const invoiceLineEntries = parsed.data.lines
    .map((l, idx) => ({ l, idx }))
    .filter(({ l }) => l.intent === 'invoice_payment');

  let outstandingByBill = new Map<
    string,
    { balance: number; contactId: string | null; billNumber: string | null }
  >();
  let outstandingByInvoice = new Map<
    string,
    { balance: number; contactId: string | null; invoiceNumber: string | null }
  >();
  if (billLineEntries.length > 0) {
    const targets = Array.from(
      new Set(billLineEntries.map((x) => x.l.intentTargetId).filter((v): v is string => !!v)),
    );
    if (targets.length === 0) {
      return { error: 'Bill payment lines need an intent target' };
    }
    for (const b of await getOutstandingBills(orgId)) {
      outstandingByBill.set(b.id, {
        balance: b.balance,
        contactId: b.contactId,
        billNumber: b.billNumber,
      });
    }
    const requestedByBill = new Map<string, number>();
    for (const { l } of billLineEntries) {
      if (!l.intentTargetId) return { error: 'Bill payment lines need an intent target' };
      requestedByBill.set(l.intentTargetId, (requestedByBill.get(l.intentTargetId) ?? 0) + l.amount);
    }
    for (const [billId, requested] of requestedByBill) {
      const b = outstandingByBill.get(billId);
      if (!b) {
        return {
          error: `Bill ${billId.slice(0, 8)} is not outstanding in this organization`,
        };
      }
      if (requested > b.balance + 0.005) {
        return {
          error: `Bill #${b.billNumber ?? billId.slice(0, 8)} balance is $${b.balance.toFixed(2)} but split lines for it total $${requested.toFixed(2)}.`,
        };
      }
    }
  }
  if (invoiceLineEntries.length > 0) {
    const targets = Array.from(
      new Set(invoiceLineEntries.map((x) => x.l.intentTargetId).filter((v): v is string => !!v)),
    );
    if (targets.length === 0) {
      return { error: 'Invoice payment lines need an intent target' };
    }
    for (const i of await getOutstandingInvoices(orgId)) {
      outstandingByInvoice.set(i.id, {
        balance: i.balance,
        contactId: i.contactId,
        invoiceNumber: i.invoiceNumber,
      });
    }
    const requestedByInvoice = new Map<string, number>();
    for (const { l } of invoiceLineEntries) {
      if (!l.intentTargetId) return { error: 'Invoice payment lines need an intent target' };
      requestedByInvoice.set(
        l.intentTargetId,
        (requestedByInvoice.get(l.intentTargetId) ?? 0) + l.amount,
      );
    }
    for (const [invoiceId, requested] of requestedByInvoice) {
      const inv = outstandingByInvoice.get(invoiceId);
      if (!inv) {
        return {
          error: `Invoice ${invoiceId.slice(0, 8)} is not outstanding in this organization`,
        };
      }
      if (requested > inv.balance + 0.005) {
        return {
          error: `Invoice #${inv.invoiceNumber ?? invoiceId.slice(0, 8)} balance is $${inv.balance.toFixed(2)} but split lines for it total $${requested.toFixed(2)}.`,
        };
      }
    }
  }

  // Resolve AP / AR once if there are intent lines.
  let apAccountId: string | null = null;
  let arAccountId: string | null = null;
  if (billLineEntries.length > 0) {
    apAccountId = await resolveApAccountId(orgId);
    if (!apAccountId) {
      return { error: 'No Accounts Payable account configured for this org' };
    }
  }
  if (invoiceLineEntries.length > 0) {
    arAccountId = await resolveArAccountId(orgId);
    if (!arAccountId) {
      return { error: 'No Accounts Receivable account configured for this org' };
    }
  }

  const resolvedLines = parsed.data.lines.map((l) => {
    const isBill = l.intent === 'bill_payment';
    const isInvoice = l.intent === 'invoice_payment';
    const billInfo = isBill && l.intentTargetId ? outstandingByBill.get(l.intentTargetId) : undefined;
    const invoiceInfo =
      isInvoice && l.intentTargetId ? outstandingByInvoice.get(l.intentTargetId) : undefined;
    const resolvedCategoryAccountId = isBill
      ? apAccountId!
      : isInvoice
        ? arAccountId!
        : l.categoryAccountId!;
    const resolvedContactId =
      l.contactId ?? billInfo?.contactId ?? invoiceInfo?.contactId ?? parsed.data.contactId ?? null;
    return { ...l, splitId: randomUUID(), resolvedCategoryAccountId, resolvedContactId, billInfo, invoiceInfo };
  });

  const txnId = randomUUID();
  const now = new Date().toISOString();
  const memo = parsed.data.description ?? null;
  // Bank line direction: net inflow > 0 → debit bank (deposit overall),
  // net inflow < 0 → credit bank (withdrawal overall). Magnitude = |net|.
  const bankIsDebit = signedAmount > 0;
  const bankAbsAmount = Math.abs(signedAmount);

  try {
    await db.transaction(async (tx) => {
      const lineJeRows = resolvedLines.map((l) => ({
        accountId: l.resolvedCategoryAccountId,
        // Deposit-type lines naturally credit (revenue/AR); withdrawal-
        // type lines debit (expense/AP). Intent flips along with type.
        debit: l.type === 'withdrawal' ? l.amount : 0,
        credit: l.type === 'deposit' ? l.amount : 0,
        contactId: l.resolvedContactId,
        memo:
          l.memo ??
          (l.intent === 'bill_payment'
            ? `Payment for Bill #${l.billInfo?.billNumber ?? l.intentTargetId?.slice(0, 8)}`
            : l.intent === 'invoice_payment'
              ? `Payment for Invoice #${l.invoiceInfo?.invoiceNumber ?? l.intentTargetId?.slice(0, 8)}`
              : memo),
      }));
      const bankLine = {
        accountId: parsed.data.bankAccountId,
        debit: bankIsDebit ? bankAbsAmount : 0,
        credit: bankIsDebit ? 0 : bankAbsAmount,
        contactId: parsed.data.contactId ?? null,
        memo,
      };

      const je = await createJournalEntry(
        {
          organizationId: orgId,
          date: parsed.data.date,
          memo: memo ?? `Split ${parsed.data.type}`,
          posted: true,
          sourceType: 'transaction',
          sourceId: txnId,
          lines: bankIsDebit ? [bankLine, ...lineJeRows] : [...lineJeRows, bankLine],
        },
        tx,
      );

      await tx.insert(transactions).values({
        id: txnId,
        organizationId: orgId,
        date: parsed.data.date,
        type: parsed.data.type,
        amount: parsed.data.amount,
        accountId: parsed.data.bankAccountId,
        // Split mode: leave categoryAccountId NULL — the per-line splits
        // are the source of truth.
        categoryAccountId: null,
        contactId: parsed.data.contactId ?? null,
        description: memo,
        userDescription: memo,
        bankDescription: memo,
        journalEntryId: je.id,
        reviewed: true,
        createdAt: now,
      });

      // Splits rows for the detail page + reports.
      await tx.insert(transactionSplits).values(
        resolvedLines.map((l, i) => ({
          id: l.splitId,
          transactionId: txnId,
          organizationId: orgId,
          categoryAccountId: l.resolvedCategoryAccountId,
          amount: String(l.amount),
          memo: l.memo ?? null,
          contactId: l.resolvedContactId,
          intent: l.intent ?? null,
          intentTargetId: l.intentTargetId ?? null,
          position: i,
        })),
      );

      // payments rows for directional intent lines so AP/AR clears.
      const paymentRows: Array<typeof payments.$inferInsert> = [];
      for (const l of resolvedLines) {
        if (l.intent === 'bill_payment' && l.intentTargetId) {
          paymentRows.push({
            id: randomUUID(),
            organizationId: orgId,
            paymentDate: parsed.data.date,
            amount: l.amount,
            type: 'sent',
            billId: l.intentTargetId,
            invoiceId: null,
            transactionId: txnId,
            transactionSplitId: l.splitId,
            journalEntryId: je.id,
          });
        } else if (l.intent === 'invoice_payment' && l.intentTargetId) {
          paymentRows.push({
            id: randomUUID(),
            organizationId: orgId,
            paymentDate: parsed.data.date,
            amount: l.amount,
            type: 'received',
            billId: null,
            invoiceId: l.intentTargetId,
            transactionId: txnId,
            transactionSplitId: l.splitId,
            journalEntryId: je.id,
          });
        }
      }
      if (paymentRows.length > 0) await tx.insert(payments).values(paymentRows);
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  // Same draft-receipt match check the single-mode create does.
  try {
    const { findReceiptMatchesForTransaction } = await import('@/lib/receipts/find-receipt-matches-for-transaction');
    await findReceiptMatchesForTransaction({ organizationId: orgId, transactionId: txnId });
  } catch (err) {
    const { logger } = await import('@/lib/logger');
    logger.error({ err: err instanceof Error ? err.message : String(err), txnId }, 'findReceiptMatchesForTransaction failed (non-fatal)');
  }

  revalidatePath('/transactions');
  if (billLineEntries.length > 0) revalidatePath('/bills');
  if (invoiceLineEntries.length > 0) revalidatePath('/invoices');
  redirect(`/transactions/${txnId}`);
}

// Silence unused-import warnings — bills/invoices are used implicitly
// via the outstanding helpers above.
void bills;
void invoices;
