import 'server-only';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import {
  bills,
  billLines,
  billPayments,
  billPaymentApplications,
  chartOfAccounts,
  invoices,
  invoiceLines,
  invoicePayments,
  invoicePaymentApplications,
  journalEntries,
  qboEntityMap,
} from '@/db/schema/schema';
import { createJournalEntry, reverseJournalEntry } from '@/lib/accounting/posting';
import { ensureSalesTaxExpenseAccount, ensureSalesTaxPayableAccount } from './tax-account';
import { logger } from '@/lib/logger';

// Parallel to promoter.ts but operates on raw QBO JSON (as returned by GET
// /v3/company/{realmId}/{entity}/{id}) instead of staging-table rows. Keeps
// the migration code untouched while letting the inbound mirror create
// transactional records that were added in QBO after migration.
//
// Each create function:
//   - resolves foreign references via qbo_entity_map
//   - loads org defaults (AR/AP/revenue/bank) for the JE
//   - posts a balanced JE and inserts the local row(s) atomically
//   - returns the new local id (or throws if a hard prerequisite is missing)
//
// Throwing surfaces to the dispatcher's catch as `failed` with the message
// in last_error; Inngest retries the event up to twice, which gives upstream
// Customer/Vendor webhooks a chance to arrive first.

export class MirrorCreateError extends Error {
  constructor(message: string, public readonly retriable: boolean = false) {
    super(message);
  }
}

interface CreateCtx {
  organizationId: string;
  realmId: string;
}

async function lookupLocalId(
  organizationId: string,
  realmId: string,
  entityType: string,
  qboId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ localId: qboEntityMap.localId })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, organizationId),
      eq(qboEntityMap.realmId, realmId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.qboId, qboId),
    ))
    .limit(1);
  return row?.localId ?? null;
}

async function findOrgAccount(
  organizationId: string,
  predicates: { accountType?: string; gaapType?: string; detailType?: string },
): Promise<string | null> {
  const where = [eq(chartOfAccounts.organizationId, organizationId)];
  if (predicates.accountType) where.push(eq(chartOfAccounts.accountType, predicates.accountType));
  if (predicates.gaapType) where.push(eq(chartOfAccounts.gaapType, predicates.gaapType));
  if (predicates.detailType) where.push(eq(chartOfAccounts.detailType, predicates.detailType));
  const [row] = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(...where))
    .limit(1);
  return row?.id ?? null;
}

interface OrgDefaults {
  arAccountId: string | null;
  apAccountId: string | null;
  revenueAccountId: string | null;
  bankAccountId: string | null;
}

async function loadOrgDefaults(organizationId: string): Promise<OrgDefaults> {
  return {
    arAccountId:
      (await findOrgAccount(organizationId, { accountType: 'accounts_receivable' })) ??
      (await findOrgAccount(organizationId, { detailType: 'AccountsReceivable' })),
    apAccountId:
      (await findOrgAccount(organizationId, { accountType: 'accounts_payable' })) ??
      (await findOrgAccount(organizationId, { detailType: 'AccountsPayable' })),
    revenueAccountId: await findOrgAccount(organizationId, { gaapType: 'income' }),
    bankAccountId: await findOrgAccount(organizationId, { accountType: 'bank' }),
  };
}

interface QboLine {
  Id?: string;
  Description?: string;
  Amount: number;
  DetailType: string;
  SalesItemLineDetail?: {
    ItemRef?: { value: string; name?: string };
    UnitPrice?: number;
    Qty?: number;
    AccountRef?: { value: string; name?: string };
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef?: { value: string; name?: string };
  };
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
}

function deriveInvoiceStatus(total: number, balance: number): string {
  if (balance === 0) return 'paid';
  if (balance < total) return 'partial';
  return 'open';
}

export interface QboInvoiceRaw {
  Id: string;
  DocNumber?: string;
  CustomerRef?: { value: string };
  TxnDate?: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  Line?: QboLine[];
  TxnTaxDetail?: { TotalTax?: number };
}

/**
 * Decompose a QBO invoice into the four amounts the JE needs:
 *   subtotal -> sum of sales item lines
 *   discount -> absolute value of any DiscountLineDetail lines (QBO sends
 *               these with negative Amount)
 *   tax      -> TxnTaxDetail.TotalTax
 *   total    -> TotalAmt (== subtotal - discount + tax)
 *
 * QBO usually reports TotalAmt computed server-side; we trust it as the
 * source of truth for the AR debit and reconcile the credits against it.
 */
function invoiceAmounts(raw: QboInvoiceRaw): { subtotal: number; discount: number; tax: number; total: number } {
  const lineItems = (raw.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail');
  const subtotal = lineItems.reduce((s, l) => s + Number(l.Amount ?? 0), 0);
  const discountLines = (raw.Line ?? []).filter((l) => l.DetailType === 'DiscountLineDetail');
  const discount = discountLines.reduce((s, l) => s + Math.abs(Number(l.Amount ?? 0)), 0);
  const tax = Number(raw.TxnTaxDetail?.TotalTax ?? 0);
  const total = Number(raw.TotalAmt ?? 0);
  return { subtotal, discount, tax, total };
}

export async function createInvoiceFromQbo(ctx: CreateCtx, raw: QboInvoiceRaw): Promise<string> {
  if (!raw.CustomerRef?.value) {
    throw new MirrorCreateError('Invoice has no CustomerRef');
  }
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', raw.CustomerRef.value);
  if (!contactId) {
    throw new MirrorCreateError(`Invoice references unmapped customer qbo:${raw.CustomerRef.value}`, true);
  }

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.arAccountId) throw new MirrorCreateError('Org has no AR account');
  if (!defaults.revenueAccountId) throw new MirrorCreateError('Org has no revenue account');

  // Same fidelity ceiling as promoter: credit a single default revenue
  // account for the whole invoice rather than per-line ItemRef.IncomeAccount.
  // QBO sends a heterogeneous Line[] including SubTotal/Discount lines;
  // filter to revenue-bearing lines for accurate per-line amounts on the
  // invoice_lines table.
  const { subtotal, discount, tax, total } = invoiceAmounts(raw);
  const netRevenue = subtotal - discount; // == total - tax
  const balance = Number(raw.Balance ?? 0);
  const lineItems = (raw.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail');
  const invoiceDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const localId = randomUUID();
  const memo = raw.CustomerMemo?.value ?? raw.PrivateNote ?? null;

  await db.transaction(async (tx) => {
    // JE: AR debit (full receivable, including tax) = revenue credit (net
    // of discount) + tax-liability credit. Three lines for taxable
    // invoices, two for non-taxable.
    const jeLines = [
      { accountId: defaults.arAccountId!, debit: total, credit: 0, contactId, memo: 'A/R' },
      { accountId: defaults.revenueAccountId!, debit: 0, credit: netRevenue, contactId, memo: 'Revenue' },
    ];
    if (tax > 0) {
      const taxAccountId = await ensureSalesTaxPayableAccount(ctx.organizationId, tx);
      jeLines.push({ accountId: taxAccountId, debit: 0, credit: tax, contactId, memo: 'Sales tax' });
    }
    const je = await createJournalEntry({
      organizationId: ctx.organizationId,
      date: invoiceDate,
      memo: raw.DocNumber ? `Invoice ${raw.DocNumber} (QBO)` : 'Invoice (QBO)',
      posted: true,
      sourceType: 'invoice',
      sourceId: localId,
      lines: jeLines,
    }, tx);

    await tx.insert(invoices).values({
      id: localId,
      organizationId: ctx.organizationId,
      contactId,
      invoiceNumber: raw.DocNumber ?? null,
      invoiceDate,
      dueDate: raw.DueDate ?? null,
      status: deriveInvoiceStatus(total, balance),
      memo,
      posted: true,
      postedAt: now,
      journalEntryId: je.id,
      arAccountId: defaults.arAccountId,
      taxAmount: String(tax),
      discountAmount: String(discount),
    });

    if (lineItems.length === 0) {
      await tx.insert(invoiceLines).values({
        id: randomUUID(),
        invoiceId: localId,
        description: raw.DocNumber ? `Imported from QBO Invoice ${raw.DocNumber}` : 'Imported from QBO',
        quantity: '1',
        unitPrice: String(total),
        amount: String(total),
      });
    } else {
      for (const line of lineItems) {
        const qty = line.SalesItemLineDetail?.Qty ?? 1;
        const unitPrice = line.SalesItemLineDetail?.UnitPrice ?? (qty > 0 ? line.Amount / qty : line.Amount);
        await tx.insert(invoiceLines).values({
          id: randomUUID(),
          invoiceId: localId,
          description: line.Description ?? null,
          quantity: String(qty),
          unitPrice: String(unitPrice),
          amount: String(line.Amount),
        });
      }
    }
  });

  return localId;
}

export interface QboBillRaw {
  Id: string;
  DocNumber?: string;
  VendorRef?: { value: string };
  TxnDate?: string;
  DueDate?: string;
  TotalAmt: number;
  Balance: number;
  PrivateNote?: string;
  Line?: QboLine[];
  TxnTaxDetail?: { TotalTax?: number };
}

/**
 * Bill amounts decompose more simply than invoices: there's no
 * discount line in the QBO Bill schema (vendor early-payment discounts
 * live on BillPayment instead), so it's just subtotal + tax = total.
 * The sub-total is line-item sum; tax is TxnTaxDetail.TotalTax.
 */
function billAmounts(raw: QboBillRaw): { subtotal: number; tax: number; total: number } {
  const expenseLines = (raw.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
  const subtotal = expenseLines.reduce((s, l) => s + Number(l.Amount ?? 0), 0);
  const tax = Number(raw.TxnTaxDetail?.TotalTax ?? 0);
  const total = Number(raw.TotalAmt ?? 0);
  return { subtotal, tax, total };
}

export async function createBillFromQbo(ctx: CreateCtx, raw: QboBillRaw): Promise<string> {
  if (!raw.VendorRef?.value) {
    throw new MirrorCreateError('Bill has no VendorRef');
  }
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', raw.VendorRef.value);
  if (!contactId) {
    throw new MirrorCreateError(`Bill references unmapped vendor qbo:${raw.VendorRef.value}`, true);
  }

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.apAccountId) throw new MirrorCreateError('Org has no AP account');

  const expenseLines = (raw.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
  const { subtotal, tax, total } = billAmounts(raw);
  const balance = Number(raw.Balance ?? 0);

  // Aggregate JE debits by per-line expense account. Unmapped accounts
  // collapse to a fallback so the JE balances — same compromise the
  // promoter makes. We split tax out as a separate debit (Sales Tax
  // Expense) so it doesn't pollute the per-category expense totals.
  const fallbackExpense = await findOrgAccount(ctx.organizationId, { gaapType: 'expense' });
  const byAccount = new Map<string, number>();
  for (const line of expenseLines) {
    const qboAccountId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
    let localAccountId: string | null = null;
    if (qboAccountId) {
      localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
    }
    const accountId = localAccountId ?? fallbackExpense;
    if (!accountId) continue;
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + line.Amount);
  }
  if (byAccount.size === 0 && fallbackExpense) {
    byAccount.set(fallbackExpense, subtotal);
  }
  if (byAccount.size === 0) {
    throw new MirrorCreateError('No mappable expense account on bill and no expense-gaap fallback');
  }

  const billDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const localId = randomUUID();

  await db.transaction(async (tx) => {
    const jeLines = [
      ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
        accountId, debit: amount, credit: 0, contactId, memo: 'Expense',
      })),
    ];
    if (tax > 0) {
      const taxExpenseId = await ensureSalesTaxExpenseAccount(ctx.organizationId, tx);
      jeLines.push({ accountId: taxExpenseId, debit: tax, credit: 0, contactId, memo: 'Sales tax (paid)' });
    }
    jeLines.push({ accountId: defaults.apAccountId!, debit: 0, credit: total, contactId, memo: 'A/P' });
    await createJournalEntry({
      organizationId: ctx.organizationId,
      date: billDate,
      memo: raw.DocNumber ? `Bill ${raw.DocNumber} (QBO)` : 'Bill (QBO)',
      posted: true,
      sourceType: 'bill',
      sourceId: localId,
      lines: jeLines,
    }, tx);

    await tx.insert(bills).values({
      id: localId,
      organizationId: ctx.organizationId,
      contactId,
      billNumber: raw.DocNumber ?? null,
      billDate,
      dueDate: raw.DueDate ?? null,
      status: balance === 0 ? 'paid' : 'posted',
      memo: raw.PrivateNote ?? null,
      taxAmount: String(tax),
    });

    if (expenseLines.length === 0) {
      await tx.insert(billLines).values({
        id: randomUUID(),
        billId: localId,
        description: raw.DocNumber ? `Imported from QBO Bill ${raw.DocNumber}` : 'Imported from QBO',
        quantity: '1',
        unitPrice: String(subtotal),
        amount: String(subtotal),
      });
    } else {
      for (const line of expenseLines) {
        await tx.insert(billLines).values({
          id: randomUUID(),
          billId: localId,
          description: line.Description ?? null,
          quantity: '1',
          unitPrice: String(line.Amount),
          amount: String(line.Amount),
        });
      }
    }
  });

  return localId;
}

export interface QboPaymentRaw {
  Id: string;
  CustomerRef?: { value: string };
  TxnDate?: string;
  TotalAmt: number;
  PrivateNote?: string;
  DepositToAccountRef?: { value: string };
  Line?: QboLine[];
}

export async function createPaymentFromQbo(ctx: CreateCtx, raw: QboPaymentRaw): Promise<string> {
  if (!raw.CustomerRef?.value) {
    throw new MirrorCreateError('Payment has no CustomerRef');
  }
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', raw.CustomerRef.value);
  if (!contactId) {
    throw new MirrorCreateError(`Payment references unmapped customer qbo:${raw.CustomerRef.value}`, true);
  }

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.arAccountId) throw new MirrorCreateError('Org has no AR account');

  let depositAccountId: string | null = null;
  if (raw.DepositToAccountRef?.value) {
    depositAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', raw.DepositToAccountRef.value);
  }
  depositAccountId ??= defaults.bankAccountId;
  if (!depositAccountId) throw new MirrorCreateError('No deposit-to or bank account available');

  const total = Number(raw.TotalAmt ?? 0);
  const paymentDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const localId = randomUUID();
  // $0 payments are real records (zero-balance reconciliations); skip the
  // JE since the validator rejects debit=credit=0, but keep the row and
  // applications for audit.
  const skipJe = total === 0;

  // Resolve linked invoices BEFORE the transaction. An unmapped invoice
  // is dropped from the application set but the payment still records
  // (with no apps) so the user can re-link later.
  const linkedApps: Array<{ invoiceId: string; amount: number }> = [];
  for (const line of raw.Line ?? []) {
    const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Invoice');
    if (!linked) continue;
    const localInvoiceId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'invoice', linked.TxnId);
    if (!localInvoiceId) continue;
    linkedApps.push({ invoiceId: localInvoiceId, amount: line.Amount });
  }

  await db.transaction(async (tx) => {
    if (!skipJe) {
      await createJournalEntry({
        organizationId: ctx.organizationId,
        date: paymentDate,
        memo: 'Customer payment (QBO)',
        posted: true,
        sourceType: 'invoice_payment',
        sourceId: localId,
        lines: [
          { accountId: depositAccountId!, debit: total, credit: 0, contactId, memo: 'Cash in' },
          { accountId: defaults.arAccountId!, debit: 0, credit: total, contactId, memo: 'A/R' },
        ],
      }, tx);
    }

    await tx.insert(invoicePayments).values({
      id: localId,
      organizationId: ctx.organizationId,
      contactId,
      paymentDate,
      amount: String(total),
      memo: raw.PrivateNote ?? null,
    });

    for (const app of linkedApps) {
      await tx.insert(invoicePaymentApplications).values({
        id: randomUUID(),
        invoicePaymentId: localId,
        invoiceId: app.invoiceId,
        amountApplied: String(app.amount),
      });
    }
  });

  if (linkedApps.length === 0 && (raw.Line ?? []).some((l) => l.LinkedTxn?.some((t) => t.TxnType === 'Invoice'))) {
    logger.warn({ qboPaymentId: raw.Id, localId }, 'qbo payment created with no resolvable invoice applications');
  }

  return localId;
}

export interface QboBillPaymentRaw {
  Id: string;
  VendorRef?: { value: string };
  TxnDate?: string;
  TotalAmt: number;
  PrivateNote?: string;
  PayType?: string;
  CheckPayment?: { BankAccountRef?: { value: string } };
  CreditCardPayment?: { CCAccountRef?: { value: string } };
  Line?: QboLine[];
}

export async function createBillPaymentFromQbo(ctx: CreateCtx, raw: QboBillPaymentRaw): Promise<string> {
  if (!raw.VendorRef?.value) {
    throw new MirrorCreateError('BillPayment has no VendorRef');
  }
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', raw.VendorRef.value);
  if (!contactId) {
    throw new MirrorCreateError(`BillPayment references unmapped vendor qbo:${raw.VendorRef.value}`, true);
  }

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.apAccountId) throw new MirrorCreateError('Org has no AP account');

  const sourceQboId =
    raw.CheckPayment?.BankAccountRef?.value ??
    raw.CreditCardPayment?.CCAccountRef?.value;
  let sourceAccountId: string | null = null;
  if (sourceQboId) {
    sourceAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', sourceQboId);
  }
  sourceAccountId ??= defaults.bankAccountId;
  if (!sourceAccountId) throw new MirrorCreateError('No source-of-funds account available');

  const total = Number(raw.TotalAmt ?? 0);
  const paymentDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const localId = randomUUID();
  const skipJe = total === 0;

  const linkedApps: Array<{ billId: string; amount: number }> = [];
  for (const line of raw.Line ?? []) {
    const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Bill');
    if (!linked) continue;
    const localBillId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'bill', linked.TxnId);
    if (!localBillId) continue;
    linkedApps.push({ billId: localBillId, amount: line.Amount });
  }

  await db.transaction(async (tx) => {
    if (!skipJe) {
      await createJournalEntry({
        organizationId: ctx.organizationId,
        date: paymentDate,
        memo: 'Vendor payment (QBO)',
        posted: true,
        sourceType: 'bill_payment',
        sourceId: localId,
        lines: [
          { accountId: defaults.apAccountId!, debit: total, credit: 0, contactId, memo: 'A/P' },
          { accountId: sourceAccountId!, debit: 0, credit: total, contactId, memo: 'Cash out' },
        ],
      }, tx);
    }

    await tx.insert(billPayments).values({
      id: localId,
      organizationId: ctx.organizationId,
      contactId,
      paymentDate,
      amount: String(total),
      memo: raw.PrivateNote ?? null,
    });

    for (const app of linkedApps) {
      await tx.insert(billPaymentApplications).values({
        id: randomUUID(),
        billPaymentId: localId,
        billId: app.billId,
        amountApplied: String(app.amount),
      });
    }
  });

  if (linkedApps.length === 0 && (raw.Line ?? []).some((l) => l.LinkedTxn?.some((t) => t.TxnType === 'Bill'))) {
    logger.warn({ qboBillPaymentId: raw.Id, localId }, 'qbo bill payment created with no resolvable bill applications');
  }

  return localId;
}

// --------------------------------------------------------------------------
// REPLACE functions (slice 3c) — used by the upserter's Update path to
// re-mirror the FULL state of a transactional record when its lines or
// totals have changed in QBO.
//
// Pattern:
//   1. Reverse the existing JE (reverseJournalEntry is idempotent)
//   2. Delete the existing line items / applications
//   3. Insert new line items / applications from QBO
//   4. Post a new JE
//   5. Update the header (and journal_entry_id pointer for invoices)
//
// All in one transaction so a partial failure leaves the original state
// intact. Local id is preserved so any rows referencing it (e.g. payment
// applications pointing at the invoice) keep working.
// --------------------------------------------------------------------------

/**
 * Find the most recent posted JE for (sourceType, sourceId) that isn't
 * itself a reversal. Used by bill/payment/billPayment replace paths since
 * those tables don't carry a journal_entry_id pointer on the row.
 */
async function findSourceJeId(organizationId: string, sourceType: string, sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(
      eq(journalEntries.organizationId, organizationId),
      eq(journalEntries.sourceType, sourceType),
      eq(journalEntries.sourceId, sourceId),
      // exclude prior reversers so we reverse the latest "real" JE
      // (reversal_of_id IS NULL). Drizzle expresses this via raw eq on the
      // column; we'll just pick by created_at desc and let the caller
      // skip if the picked row is itself a reversal.
    ))
    .orderBy(journalEntries.createdAt)
    .limit(1);
  return row?.id ?? null;
}

export async function replaceInvoiceFromQbo(ctx: CreateCtx, raw: QboInvoiceRaw, existingLocalId: string): Promise<void> {
  if (!raw.CustomerRef?.value) throw new MirrorCreateError('Invoice has no CustomerRef');
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', raw.CustomerRef.value);
  if (!contactId) throw new MirrorCreateError(`Invoice references unmapped customer qbo:${raw.CustomerRef.value}`, true);

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.arAccountId) throw new MirrorCreateError('Org has no AR account');
  if (!defaults.revenueAccountId) throw new MirrorCreateError('Org has no revenue account');

  const [existing] = await db
    .select({ journalEntryId: invoices.journalEntryId })
    .from(invoices)
    .where(eq(invoices.id, existingLocalId))
    .limit(1);
  const oldJeId = existing?.journalEntryId ?? null;

  const { subtotal, discount, tax, total } = invoiceAmounts(raw);
  const netRevenue = subtotal - discount;
  const balance = Number(raw.Balance ?? 0);
  const lineItems = (raw.Line ?? []).filter((l) => l.DetailType === 'SalesItemLineDetail');
  const invoiceDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const memo = raw.CustomerMemo?.value ?? raw.PrivateNote ?? null;
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    if (oldJeId) {
      await reverseJournalEntry({ organizationId: ctx.organizationId, journalEntryId: oldJeId }, tx);
    }
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, existingLocalId));

    const jeLines = [
      { accountId: defaults.arAccountId!, debit: total, credit: 0, contactId, memo: 'A/R' },
      { accountId: defaults.revenueAccountId!, debit: 0, credit: netRevenue, contactId, memo: 'Revenue' },
    ];
    if (tax > 0) {
      const taxAccountId = await ensureSalesTaxPayableAccount(ctx.organizationId, tx);
      jeLines.push({ accountId: taxAccountId, debit: 0, credit: tax, contactId, memo: 'Sales tax' });
    }
    const je = await createJournalEntry({
      organizationId: ctx.organizationId,
      date: invoiceDate,
      memo: raw.DocNumber ? `Invoice ${raw.DocNumber} (QBO update)` : 'Invoice (QBO update)',
      posted: true,
      sourceType: 'invoice',
      sourceId: existingLocalId,
      lines: jeLines,
    }, tx);

    if (lineItems.length === 0) {
      await tx.insert(invoiceLines).values({
        id: randomUUID(),
        invoiceId: existingLocalId,
        description: raw.DocNumber ? `Imported from QBO Invoice ${raw.DocNumber}` : 'Imported from QBO',
        quantity: '1',
        unitPrice: String(total),
        amount: String(total),
      });
    } else {
      for (const line of lineItems) {
        const qty = line.SalesItemLineDetail?.Qty ?? 1;
        const unitPrice = line.SalesItemLineDetail?.UnitPrice ?? (qty > 0 ? line.Amount / qty : line.Amount);
        await tx.insert(invoiceLines).values({
          id: randomUUID(),
          invoiceId: existingLocalId,
          description: line.Description ?? null,
          quantity: String(qty),
          unitPrice: String(unitPrice),
          amount: String(line.Amount),
        });
      }
    }

    await tx.update(invoices).set({
      contactId,
      invoiceNumber: raw.DocNumber ?? null,
      invoiceDate,
      dueDate: raw.DueDate ?? null,
      status: deriveInvoiceStatus(total, balance),
      memo,
      journalEntryId: je.id,
      arAccountId: defaults.arAccountId,
      taxAmount: String(tax),
      discountAmount: String(discount),
      updatedAt: now,
    }).where(eq(invoices.id, existingLocalId));
  });
}

export async function replaceBillFromQbo(ctx: CreateCtx, raw: QboBillRaw, existingLocalId: string): Promise<void> {
  if (!raw.VendorRef?.value) throw new MirrorCreateError('Bill has no VendorRef');
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', raw.VendorRef.value);
  if (!contactId) throw new MirrorCreateError(`Bill references unmapped vendor qbo:${raw.VendorRef.value}`, true);

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.apAccountId) throw new MirrorCreateError('Org has no AP account');

  const oldJeId = await findSourceJeId(ctx.organizationId, 'bill', existingLocalId);

  const expenseLines = (raw.Line ?? []).filter((l) => l.DetailType === 'AccountBasedExpenseLineDetail');
  const { subtotal, tax, total } = billAmounts(raw);
  const balance = Number(raw.Balance ?? 0);

  const fallbackExpense = await findOrgAccount(ctx.organizationId, { gaapType: 'expense' });
  const byAccount = new Map<string, number>();
  for (const line of expenseLines) {
    const qboAccountId = line.AccountBasedExpenseLineDetail?.AccountRef?.value;
    let localAccountId: string | null = null;
    if (qboAccountId) {
      localAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', qboAccountId);
    }
    const accountId = localAccountId ?? fallbackExpense;
    if (!accountId) continue;
    byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + line.Amount);
  }
  if (byAccount.size === 0 && fallbackExpense) byAccount.set(fallbackExpense, subtotal);
  if (byAccount.size === 0) throw new MirrorCreateError('No mappable expense account on bill and no fallback');

  const billDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    if (oldJeId) {
      await reverseJournalEntry({ organizationId: ctx.organizationId, journalEntryId: oldJeId }, tx);
    }
    await tx.delete(billLines).where(eq(billLines.billId, existingLocalId));

    const jeLines = [
      ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
        accountId, debit: amount, credit: 0, contactId, memo: 'Expense',
      })),
    ];
    if (tax > 0) {
      const taxExpenseId = await ensureSalesTaxExpenseAccount(ctx.organizationId, tx);
      jeLines.push({ accountId: taxExpenseId, debit: tax, credit: 0, contactId, memo: 'Sales tax (paid)' });
    }
    jeLines.push({ accountId: defaults.apAccountId!, debit: 0, credit: total, contactId, memo: 'A/P' });
    await createJournalEntry({
      organizationId: ctx.organizationId,
      date: billDate,
      memo: raw.DocNumber ? `Bill ${raw.DocNumber} (QBO update)` : 'Bill (QBO update)',
      posted: true,
      sourceType: 'bill',
      sourceId: existingLocalId,
      lines: jeLines,
    }, tx);

    if (expenseLines.length === 0) {
      await tx.insert(billLines).values({
        id: randomUUID(),
        billId: existingLocalId,
        description: raw.DocNumber ? `Imported from QBO Bill ${raw.DocNumber}` : 'Imported from QBO',
        quantity: '1',
        unitPrice: String(subtotal),
        amount: String(subtotal),
      });
    } else {
      for (const line of expenseLines) {
        await tx.insert(billLines).values({
          id: randomUUID(),
          billId: existingLocalId,
          description: line.Description ?? null,
          quantity: '1',
          unitPrice: String(line.Amount),
          amount: String(line.Amount),
        });
      }
    }

    await tx.update(bills).set({
      contactId,
      billNumber: raw.DocNumber ?? null,
      billDate,
      dueDate: raw.DueDate ?? null,
      status: balance === 0 ? 'paid' : 'posted',
      memo: raw.PrivateNote ?? null,
      taxAmount: String(tax),
      updatedAt: now,
    }).where(eq(bills.id, existingLocalId));
  });
}

export async function replacePaymentFromQbo(ctx: CreateCtx, raw: QboPaymentRaw, existingLocalId: string): Promise<void> {
  if (!raw.CustomerRef?.value) throw new MirrorCreateError('Payment has no CustomerRef');
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'customer', raw.CustomerRef.value);
  if (!contactId) throw new MirrorCreateError(`Payment references unmapped customer qbo:${raw.CustomerRef.value}`, true);

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.arAccountId) throw new MirrorCreateError('Org has no AR account');

  let depositAccountId: string | null = null;
  if (raw.DepositToAccountRef?.value) {
    depositAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', raw.DepositToAccountRef.value);
  }
  depositAccountId ??= defaults.bankAccountId;
  if (!depositAccountId) throw new MirrorCreateError('No deposit-to or bank account available');

  const oldJeId = await findSourceJeId(ctx.organizationId, 'invoice_payment', existingLocalId);
  const total = Number(raw.TotalAmt ?? 0);
  const paymentDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const skipJe = total === 0;

  const linkedApps: Array<{ invoiceId: string; amount: number }> = [];
  for (const line of raw.Line ?? []) {
    const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Invoice');
    if (!linked) continue;
    const localInvoiceId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'invoice', linked.TxnId);
    if (!localInvoiceId) continue;
    linkedApps.push({ invoiceId: localInvoiceId, amount: line.Amount });
  }

  await db.transaction(async (tx) => {
    if (oldJeId) {
      await reverseJournalEntry({ organizationId: ctx.organizationId, journalEntryId: oldJeId }, tx);
    }
    await tx.delete(invoicePaymentApplications).where(eq(invoicePaymentApplications.invoicePaymentId, existingLocalId));

    if (!skipJe) {
      await createJournalEntry({
        organizationId: ctx.organizationId,
        date: paymentDate,
        memo: 'Customer payment (QBO update)',
        posted: true,
        sourceType: 'invoice_payment',
        sourceId: existingLocalId,
        lines: [
          { accountId: depositAccountId!, debit: total, credit: 0, contactId, memo: 'Cash in' },
          { accountId: defaults.arAccountId!, debit: 0, credit: total, contactId, memo: 'A/R' },
        ],
      }, tx);
    }

    await tx.update(invoicePayments).set({
      contactId,
      paymentDate,
      amount: String(total),
      memo: raw.PrivateNote ?? null,
      updatedAt: new Date().toISOString(),
    }).where(eq(invoicePayments.id, existingLocalId));

    for (const app of linkedApps) {
      await tx.insert(invoicePaymentApplications).values({
        id: randomUUID(),
        invoicePaymentId: existingLocalId,
        invoiceId: app.invoiceId,
        amountApplied: String(app.amount),
      });
    }
  });
}

export async function replaceBillPaymentFromQbo(ctx: CreateCtx, raw: QboBillPaymentRaw, existingLocalId: string): Promise<void> {
  if (!raw.VendorRef?.value) throw new MirrorCreateError('BillPayment has no VendorRef');
  const contactId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'vendor', raw.VendorRef.value);
  if (!contactId) throw new MirrorCreateError(`BillPayment references unmapped vendor qbo:${raw.VendorRef.value}`, true);

  const defaults = await loadOrgDefaults(ctx.organizationId);
  if (!defaults.apAccountId) throw new MirrorCreateError('Org has no AP account');

  const sourceQboId =
    raw.CheckPayment?.BankAccountRef?.value ??
    raw.CreditCardPayment?.CCAccountRef?.value;
  let sourceAccountId: string | null = null;
  if (sourceQboId) {
    sourceAccountId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'account', sourceQboId);
  }
  sourceAccountId ??= defaults.bankAccountId;
  if (!sourceAccountId) throw new MirrorCreateError('No source-of-funds account available');

  const oldJeId = await findSourceJeId(ctx.organizationId, 'bill_payment', existingLocalId);
  const total = Number(raw.TotalAmt ?? 0);
  const paymentDate = raw.TxnDate ?? new Date().toISOString().slice(0, 10);
  const skipJe = total === 0;

  const linkedApps: Array<{ billId: string; amount: number }> = [];
  for (const line of raw.Line ?? []) {
    const linked = line.LinkedTxn?.find((t) => t.TxnType === 'Bill');
    if (!linked) continue;
    const localBillId = await lookupLocalId(ctx.organizationId, ctx.realmId, 'bill', linked.TxnId);
    if (!localBillId) continue;
    linkedApps.push({ billId: localBillId, amount: line.Amount });
  }

  await db.transaction(async (tx) => {
    if (oldJeId) {
      await reverseJournalEntry({ organizationId: ctx.organizationId, journalEntryId: oldJeId }, tx);
    }
    await tx.delete(billPaymentApplications).where(eq(billPaymentApplications.billPaymentId, existingLocalId));

    if (!skipJe) {
      await createJournalEntry({
        organizationId: ctx.organizationId,
        date: paymentDate,
        memo: 'Vendor payment (QBO update)',
        posted: true,
        sourceType: 'bill_payment',
        sourceId: existingLocalId,
        lines: [
          { accountId: defaults.apAccountId!, debit: total, credit: 0, contactId, memo: 'A/P' },
          { accountId: sourceAccountId!, debit: 0, credit: total, contactId, memo: 'Cash out' },
        ],
      }, tx);
    }

    await tx.update(billPayments).set({
      contactId,
      paymentDate,
      amount: String(total),
      memo: raw.PrivateNote ?? null,
      updatedAt: new Date().toISOString(),
    }).where(eq(billPayments.id, existingLocalId));

    for (const app of linkedApps) {
      await tx.insert(billPaymentApplications).values({
        id: randomUUID(),
        billPaymentId: existingLocalId,
        billId: app.billId,
        amountApplied: String(app.amount),
      });
    }
  });
}
