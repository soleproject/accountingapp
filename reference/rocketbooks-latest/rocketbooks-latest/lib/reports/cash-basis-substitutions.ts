import 'server-only';
import { eq, and, gte, lte, isNotNull, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  bills,
  chartOfAccounts,
  invoices,
  journalEntries,
  journalEntryLines,
  payments,
} from '@/db/schema/schema';

/**
 * Cash-basis re-recognition.
 *
 * When the cash-basis filter excludes invoice and bill JEs, the revenue /
 * expense recognition that lived in those JEs disappears too. To put it
 * back on the cash side, this helper produces "synthetic" GL rows — keyed
 * by payment JE — that recognize the source invoice's revenue (or bill's
 * expense) on the payment date.
 *
 * The synthetic row replaces the AR / AP credit-side leg of the payment
 * JE; the cash-side debit/credit leg of the payment JE stays as-is in the
 * standard query, so cash inflows/outflows still show correctly.
 */
export interface CashBasisSubstitution {
  /** JE id of the payment that's being re-recognized. */
  paymentJournalEntryId: string;
  /** Payment date (= recognition date under cash basis). */
  date: string;
  /** Account whose balance gets bumped — revenue for invoice payments,
   *  expense for bill payments. */
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  accountType: string | null;
  /** Direction: 'credit' for revenue (invoice payments), 'debit' for
   *  expense (bill payments). */
  side: 'debit' | 'credit';
  amount: number;
  contactId: string | null;
}

/**
 * For every invoice payment in the period, look up the source invoice's
 * revenue lines and produce one synthetic row per (payment, revenue
 * account). Allocates proportionally when the payment doesn't equal the
 * invoice total (partial payment / overpayment).
 */
async function loadInvoicePaymentSubstitutions(
  orgId: string,
  fromDate: string,
  toDate: string,
): Promise<CashBasisSubstitution[]> {
  // Step 1: payment-JE rows in period that paid an invoice.
  const paymentRows = await db
    .select({
      paymentJournalEntryId: payments.journalEntryId,
      paymentDate: payments.paymentDate,
      paymentAmount: payments.amount,
      invoiceId: payments.invoiceId,
      contactId: payments.customerId,
    })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, orgId),
        eq(payments.type, 'received'),
        isNotNull(payments.invoiceId),
        isNotNull(payments.journalEntryId),
        gte(payments.paymentDate, fromDate),
        lte(payments.paymentDate, toDate),
      ),
    );
  if (paymentRows.length === 0) return [];

  const invoiceIds = Array.from(
    new Set(paymentRows.map((r) => r.invoiceId).filter((x): x is string => !!x)),
  );

  // Step 2: invoice JEs and their revenue (Cr) lines, plus the invoice's
  // total so we can pro-rate partial payments.
  const invoiceMeta = await db
    .select({
      id: invoices.id,
      arAccountId: invoices.arAccountId,
      journalEntryId: invoices.journalEntryId,
    })
    .from(invoices)
    .where(and(eq(invoices.organizationId, orgId), inArray(invoices.id, invoiceIds)));
  const invoiceJeIds = invoiceMeta
    .map((i) => i.journalEntryId)
    .filter((x): x is string => !!x);
  if (invoiceJeIds.length === 0) return [];

  const invoiceLines = await db
    .select({
      jeId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
    .where(inArray(journalEntryLines.journalEntryId, invoiceJeIds));

  // Group invoice JE lines by jeId, dropping the AR-side debit (which is
  // what cash basis is replacing). What remains are the credit (revenue)
  // lines we'll allocate against the payment.
  type RevenueLine = {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    gaapType: string | null;
    accountType: string | null;
    amount: number;
  };
  const invoiceJeRevenueByInvoice = new Map<
    string,
    { revenueLines: RevenueLine[]; total: number }
  >();
  for (const meta of invoiceMeta) {
    if (!meta.journalEntryId) continue;
    const jeLines = invoiceLines.filter((l) => l.jeId === meta.journalEntryId);
    const revenue: RevenueLine[] = [];
    for (const l of jeLines) {
      if (!l.accountId) continue;
      // Skip the AR line — it's the cash-basis substitution target, not
      // the source.
      if (meta.arAccountId && l.accountId === meta.arAccountId) continue;
      const credit = Number(l.credit ?? 0);
      if (credit <= 0) continue;
      revenue.push({
        accountId: l.accountId,
        accountNumber: l.accountNumber,
        accountName: l.accountName ?? '',
        gaapType: l.gaapType,
        accountType: l.accountType,
        amount: credit,
      });
    }
    const total = revenue.reduce((s, r) => s + r.amount, 0);
    if (total > 0) invoiceJeRevenueByInvoice.set(meta.id, { revenueLines: revenue, total });
  }

  // For the AR-reversal row we need account metadata, so look up the AR
  // account names alongside the invoice metadata.
  const arAccountIds = Array.from(
    new Set(invoiceMeta.map((m) => m.arAccountId).filter((x): x is string => !!x)),
  );
  const arAccounts =
    arAccountIds.length > 0
      ? await db
          .select({
            id: chartOfAccounts.id,
            accountNumber: chartOfAccounts.accountNumber,
            accountName: chartOfAccounts.accountName,
            gaapType: chartOfAccounts.gaapType,
            accountType: chartOfAccounts.accountType,
          })
          .from(chartOfAccounts)
          .where(inArray(chartOfAccounts.id, arAccountIds))
      : [];
  const arAccountMeta = new Map(arAccounts.map((a) => [a.id, a]));
  const invoiceArByInvoice = new Map(
    invoiceMeta.map((m) => [m.id, m.arAccountId ?? null]),
  );

  const out: CashBasisSubstitution[] = [];
  for (const p of paymentRows) {
    if (!p.invoiceId || !p.paymentJournalEntryId) continue;
    const inv = invoiceJeRevenueByInvoice.get(p.invoiceId);
    if (!inv || inv.total <= 0) continue;
    const ratio = p.paymentAmount / inv.total;
    // Recognition: revenue, allocated proportionally across the invoice's
    // revenue accounts.
    for (const line of inv.revenueLines) {
      out.push({
        paymentJournalEntryId: p.paymentJournalEntryId,
        date: p.paymentDate,
        accountId: line.accountId,
        accountNumber: line.accountNumber,
        accountName: line.accountName,
        gaapType: line.gaapType,
        accountType: line.accountType,
        side: 'credit',
        amount: line.amount * ratio,
        contactId: p.contactId,
      });
    }
    // AR reversal: add a debit equal to the payment amount so the AR
    // account ends at $0 (the payment JE's Cr AR is still in the GL since
    // payment JEs aren't filtered out).
    const arId = invoiceArByInvoice.get(p.invoiceId);
    if (arId) {
      const arMeta = arAccountMeta.get(arId);
      out.push({
        paymentJournalEntryId: p.paymentJournalEntryId,
        date: p.paymentDate,
        accountId: arId,
        accountNumber: arMeta?.accountNumber ?? null,
        accountName: arMeta?.accountName ?? 'Accounts Receivable',
        gaapType: arMeta?.gaapType ?? 'asset',
        accountType: arMeta?.accountType ?? 'accounts_receivable',
        side: 'debit',
        amount: p.paymentAmount,
        contactId: p.contactId,
      });
    }
  }
  return out;
}

/**
 * Mirror of the invoice flow for bill payments → expense recognition.
 * The bills table doesn't track its own JE id or AP account, so we find
 * the bill JE through journal_entries.source_type='bill' / source_id and
 * identify expense lines by debit (the AP line is always the credit side).
 */
async function loadBillPaymentSubstitutions(
  orgId: string,
  fromDate: string,
  toDate: string,
): Promise<CashBasisSubstitution[]> {
  const paymentRows = await db
    .select({
      paymentJournalEntryId: payments.journalEntryId,
      paymentDate: payments.paymentDate,
      paymentAmount: payments.amount,
      billId: payments.billId,
      contactId: payments.vendorId,
    })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, orgId),
        eq(payments.type, 'sent'),
        isNotNull(payments.billId),
        isNotNull(payments.journalEntryId),
        gte(payments.paymentDate, fromDate),
        lte(payments.paymentDate, toDate),
      ),
    );
  if (paymentRows.length === 0) return [];

  const billIds = Array.from(
    new Set(paymentRows.map((r) => r.billId).filter((x): x is string => !!x)),
  );

  // Find the bill JEs via sourceType/sourceId.
  const billJeRows = await db
    .select({ id: journalEntries.id, billId: journalEntries.sourceId })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.organizationId, orgId),
        eq(journalEntries.sourceType, 'bill'),
        inArray(journalEntries.sourceId, billIds),
      ),
    );
  const billJeIdsByBill = new Map<string, string>();
  for (const r of billJeRows) {
    if (r.billId) billJeIdsByBill.set(r.billId, r.id);
  }
  const billJeIds = Array.from(billJeIdsByBill.values());
  if (billJeIds.length === 0) return [];

  const billLineRows = await db
    .select({
      jeId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
    .where(inArray(journalEntryLines.journalEntryId, billJeIds));

  type ExpenseLine = {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    gaapType: string | null;
    accountType: string | null;
    amount: number;
  };
  const billExpenseByBill = new Map<
    string,
    { expenseLines: ExpenseLine[]; total: number }
  >();
  for (const [billId, jeId] of billJeIdsByBill) {
    const jeLines = billLineRows.filter((l) => l.jeId === jeId);
    const expense: ExpenseLine[] = [];
    for (const l of jeLines) {
      if (!l.accountId) continue;
      const debit = Number(l.debit ?? 0);
      // Only debit lines are expense; the credit line is AP.
      if (debit <= 0) continue;
      expense.push({
        accountId: l.accountId,
        accountNumber: l.accountNumber,
        accountName: l.accountName ?? '',
        gaapType: l.gaapType,
        accountType: l.accountType,
        amount: debit,
      });
    }
    const total = expense.reduce((s, r) => s + r.amount, 0);
    if (total > 0) billExpenseByBill.set(billId, { expenseLines: expense, total });
  }

  // The AP account for each bill is the credit line on the bill JE.
  const billApByBill = new Map<string, {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    gaapType: string | null;
    accountType: string | null;
  }>();
  for (const [billId, jeId] of billJeIdsByBill) {
    const credit = billLineRows.find((l) => l.jeId === jeId && Number(l.credit ?? 0) > 0);
    if (credit?.accountId) {
      billApByBill.set(billId, {
        accountId: credit.accountId,
        accountNumber: credit.accountNumber,
        accountName: credit.accountName ?? 'Accounts Payable',
        gaapType: credit.gaapType,
        accountType: credit.accountType,
      });
    }
  }

  const out: CashBasisSubstitution[] = [];
  for (const p of paymentRows) {
    if (!p.billId || !p.paymentJournalEntryId) continue;
    const bm = billExpenseByBill.get(p.billId);
    if (!bm || bm.total <= 0) continue;
    const ratio = p.paymentAmount / bm.total;
    for (const line of bm.expenseLines) {
      out.push({
        paymentJournalEntryId: p.paymentJournalEntryId,
        date: p.paymentDate,
        accountId: line.accountId,
        accountNumber: line.accountNumber,
        accountName: line.accountName,
        gaapType: line.gaapType,
        accountType: line.accountType,
        side: 'debit',
        amount: line.amount * ratio,
        contactId: p.contactId,
      });
    }
    // AP reversal: add a credit equal to the payment amount so the AP
    // account ends at $0.
    const apMeta = billApByBill.get(p.billId);
    if (apMeta) {
      out.push({
        paymentJournalEntryId: p.paymentJournalEntryId,
        date: p.paymentDate,
        accountId: apMeta.accountId,
        accountNumber: apMeta.accountNumber,
        accountName: apMeta.accountName,
        gaapType: apMeta.gaapType,
        accountType: apMeta.accountType,
        side: 'credit',
        amount: p.paymentAmount,
        contactId: p.contactId,
      });
    }
  }
  return out;
}

/** Combined: invoice + bill payment substitutions for the period. */
export async function loadCashBasisSubstitutions(
  orgId: string,
  fromDate: string,
  toDate: string,
): Promise<CashBasisSubstitution[]> {
  const [inv, bill] = await Promise.all([
    loadInvoicePaymentSubstitutions(orgId, fromDate, toDate),
    loadBillPaymentSubstitutions(orgId, fromDate, toDate),
  ]);
  return [...inv, ...bill];
}

/** Same combined loader but accepts an as-of cutoff (everything ≤ asOf).
 *  Used by the BS / TB which are point-in-time, not period-bounded. */
export async function loadCashBasisSubstitutionsAsOf(
  orgId: string,
  asOfDate: string,
): Promise<CashBasisSubstitution[]> {
  return loadCashBasisSubstitutions(orgId, '1900-01-01', asOfDate);
}
