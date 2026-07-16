import 'server-only';
import type { chartOfAccounts, contacts } from '@/db/schema/schema';
import { localAccountTypeToQbo } from '@/lib/qbo/promote/account-types';

// Local → QBO JSON. Inverse of the shapes that creators.ts / promoter.ts
// consume on the inbound side. We deliberately keep these as pure functions
// (no I/O) so they can be called inside a transaction without touching the
// pool — the caller passes in the loaded row(s) plus any cross-entity ids
// already resolved.

type LocalContact = typeof contacts.$inferSelect;

export interface QboCustomerPayload {
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  Active?: boolean;
}

export interface QboVendorPayload {
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  Active?: boolean;
}

/**
 * QBO requires DisplayName for both Customer and Vendor. Email + phone are
 * optional but only accepted in the nested envelope shape, never as bare
 * strings. Active=false retires the record without deleting it.
 */
export function serializeContactToCustomer(local: LocalContact): QboCustomerPayload {
  const payload: QboCustomerPayload = {
    DisplayName: local.contactName,
    Active: local.isActive,
  };
  if (local.companyName) payload.CompanyName = local.companyName;
  if (local.email) payload.PrimaryEmailAddr = { Address: local.email };
  if (local.phone) payload.PrimaryPhone = { FreeFormNumber: local.phone };
  return payload;
}

type LocalAccount = typeof chartOfAccounts.$inferSelect;

export interface QboAccountPayload {
  Name: string;
  AccountType: string;
  AcctNum?: string;
  Active?: boolean;
}

/**
 * Local chart_of_accounts row → QBO Account create body. Parent linkage and
 * opening balance are intentionally omitted; supporting them requires
 * resolving parent QBO ids and posting an opening-balance JE on the QBO
 * side, both of which can land in follow-up slices without breaking the
 * single-account create path.
 */
export function serializeChartOfAccountToQbo(local: LocalAccount): QboAccountPayload {
  const payload: QboAccountPayload = {
    Name: local.accountName,
    AccountType: localAccountTypeToQbo({
      gaapType: local.gaapType,
      accountType: local.accountType,
    }),
  };
  if (local.accountNumber && !local.accountNumber.startsWith('qbo:')) {
    // accountNumber values like "qbo:123" are placeholders the migration
    // creates when QBO didn't send an AcctNum. Don't send them back.
    payload.AcctNum = local.accountNumber;
  }
  if (local.isActive !== null && local.isActive !== undefined) {
    payload.Active = local.isActive;
  }
  return payload;
}

export function serializeContactToVendor(local: LocalContact): QboVendorPayload {
  const payload: QboVendorPayload = {
    DisplayName: local.contactName,
    Active: local.isActive,
  };
  if (local.companyName) payload.CompanyName = local.companyName;
  if (local.email) payload.PrimaryEmailAddr = { Address: local.email };
  if (local.phone) payload.PrimaryPhone = { FreeFormNumber: local.phone };
  return payload;
}

// --------------------------------------------------------------------------
// Transactional outbound. Each serializer takes the local row + all
// foreign-key QBO ids already resolved. Callers in the server actions do
// the entity_map lookups before calling these; if a required ref isn't
// mapped yet the caller can skip enqueue rather than producing a payload
// that QBO would 400 on.
// --------------------------------------------------------------------------

export interface BillLineInput {
  description: string | null;
  amount: number;
  /** QBO id of the expense account this line debits. */
  expenseAccountQboId: string;
}

export interface QboBillPayload {
  VendorRef: { value: string };
  TxnDate?: string;
  DueDate?: string;
  PrivateNote?: string;
  Line: Array<{
    DetailType: 'AccountBasedExpenseLineDetail';
    Amount: number;
    Description?: string;
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: string };
      /** TAX/NON to flag taxable lines for QBO purchase-tax mode. */
      TaxCodeRef?: { value: string };
    };
  }>;
  /** Manual tax override for vendors. Honored when QBO's purchase-tax
   *  mode is OFF; when ON, QBO ignores this and computes from line
   *  TaxCodeRefs. Sending it is harmless in both modes. */
  TxnTaxDetail?: { TotalTax: number };
}

export function serializeBillToQbo(args: {
  vendorQboId: string;
  txnDate?: string | null;
  dueDate?: string | null;
  memo?: string | null;
  lines: BillLineInput[];
  /** Flat dollar tax paid on the bill. When > 0 we mark every line
   *  taxable AND set TxnTaxDetail.TotalTax so both QBO modes work. */
  taxAmount?: number;
}): QboBillPayload {
  const taxable = (args.taxAmount ?? 0) > 0;
  const payload: QboBillPayload = {
    VendorRef: { value: args.vendorQboId },
    Line: args.lines.map((l) => ({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: l.amount,
      ...(l.description ? { Description: l.description } : {}),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: l.expenseAccountQboId },
        TaxCodeRef: { value: taxable ? 'TAX' : 'NON' },
      },
    })),
  };
  if (args.txnDate) payload.TxnDate = args.txnDate;
  if (args.dueDate) payload.DueDate = args.dueDate;
  if (args.memo) payload.PrivateNote = args.memo;
  if (taxable) payload.TxnTaxDetail = { TotalTax: args.taxAmount! };
  return payload;
}

export interface QboPaymentPayload {
  CustomerRef: { value: string };
  TotalAmt: number;
  TxnDate?: string;
  PrivateNote?: string;
  DepositToAccountRef?: { value: string };
  Line?: Array<{
    Amount: number;
    LinkedTxn: Array<{ TxnId: string; TxnType: 'Invoice' }>;
  }>;
}

/**
 * Customer payment (QBO Payment). When linkedInvoiceQboId is provided we
 * apply the full amount to that invoice; otherwise QBO holds the payment
 * as a credit on the customer's open balance.
 */
export function serializePaymentReceivedToQbo(args: {
  customerQboId: string;
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  depositAccountQboId?: string | null;
  linkedInvoiceQboId?: string | null;
}): QboPaymentPayload {
  const payload: QboPaymentPayload = {
    CustomerRef: { value: args.customerQboId },
    TotalAmt: args.amount,
  };
  if (args.paymentDate) payload.TxnDate = args.paymentDate;
  if (args.memo) payload.PrivateNote = args.memo;
  if (args.depositAccountQboId) payload.DepositToAccountRef = { value: args.depositAccountQboId };
  if (args.linkedInvoiceQboId) {
    payload.Line = [{
      Amount: args.amount,
      LinkedTxn: [{ TxnId: args.linkedInvoiceQboId, TxnType: 'Invoice' }],
    }];
  }
  return payload;
}

// Invoice outbound. QBO Invoice lines REQUIRE ItemRef.value (not just
// AccountRef as Bill lines do), so the caller must resolve each line's
// item QBO id before serializing. The createInvoice flow has only a
// revenue-account id per line, not an item id, so a "best-item-for-
// account" lookup happens at the action layer; this serializer is pure.
export interface InvoiceLineInput {
  description: string | null;
  amount: number;
  quantity?: number;
  unitPrice?: number;
  /** Item id in QBO (e.g. "1" for the default Services item in sandbox). */
  itemQboId: string;
  /** Whether this line participates in QBO's AutomatedSalesTax. When
   *  true, QBO computes tax based on the customer's jurisdiction; when
   *  false (or omitted), the line is non-taxable. Default false. */
  taxable?: boolean;
}

type QboInvoiceLine =
  | {
      DetailType: 'SalesItemLineDetail';
      Amount: number;
      Description?: string;
      SalesItemLineDetail: {
        ItemRef: { value: string };
        Qty?: number;
        UnitPrice?: number;
        /** TAX or NON in US AutomatedSalesTax mode. Without this,
         *  QBO can't decide whether to tax the line and the auto-
         *  computed TotalTax ends up zero. */
        TaxCodeRef?: { value: string };
      };
    }
  | {
      // QBO discount line. Amount is sent as POSITIVE here; QBO
      // internally treats DiscountLineDetail as a negative against the
      // running total. PercentBased=false makes it a flat dollar
      // discount (we don't expose a percent UI).
      DetailType: 'DiscountLineDetail';
      Amount: number;
      DiscountLineDetail: { PercentBased: false };
    };

export interface QboInvoicePayload {
  CustomerRef: { value: string };
  TxnDate?: string;
  DueDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  CustomerMemo?: { value: string };
  Line: QboInvoiceLine[];
  /** Manual tax override. Suppresses AutomatedSalesTax recomputation so
   *  the value RocketSuite sends is the value QBO records. */
  TxnTaxDetail?: { TotalTax: number };
}

export function serializeInvoiceToQbo(args: {
  customerQboId: string;
  docNumber?: string | null;
  txnDate?: string | null;
  dueDate?: string | null;
  memo?: string | null;
  customerMemo?: string | null;
  lines: InvoiceLineInput[];
  /** Flat dollar discount applied at the invoice header. Adds a
   *  DiscountLineDetail line; omitted when 0/undefined. */
  discountAmount?: number;
  /** Flat dollar tax. Sent as TxnTaxDetail.TotalTax to override any
   *  QBO automated-sales-tax calculation; omitted when 0/undefined. */
  taxAmount?: number;
}): QboInvoicePayload {
  const lines: QboInvoiceLine[] = args.lines.map((l) => {
    const detail: { ItemRef: { value: string }; Qty?: number; UnitPrice?: number; TaxCodeRef?: { value: string } } = {
      ItemRef: { value: l.itemQboId },
    };
    if (l.quantity !== undefined) detail.Qty = l.quantity;
    if (l.unitPrice !== undefined) detail.UnitPrice = l.unitPrice;
    // Always emit TaxCodeRef so AutomatedSalesTax (US default) knows
    // whether to tax this line. TAX/NON are QBO's built-in codes; orgs
    // outside the US with custom tax codes would need a richer mapping
    // (future slice — store local tax_code, mirror QBO TaxCode entity).
    detail.TaxCodeRef = { value: l.taxable ? 'TAX' : 'NON' };
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: l.amount,
      ...(l.description ? { Description: l.description } : {}),
      SalesItemLineDetail: detail,
    };
  });
  if (args.discountAmount && args.discountAmount > 0) {
    lines.push({
      DetailType: 'DiscountLineDetail',
      Amount: args.discountAmount,
      DiscountLineDetail: { PercentBased: false },
    });
  }
  const payload: QboInvoicePayload = {
    CustomerRef: { value: args.customerQboId },
    Line: lines,
  };
  if (args.docNumber) payload.DocNumber = args.docNumber;
  if (args.txnDate) payload.TxnDate = args.txnDate;
  if (args.dueDate) payload.DueDate = args.dueDate;
  if (args.memo) payload.PrivateNote = args.memo;
  if (args.customerMemo) payload.CustomerMemo = { value: args.customerMemo };
  if (args.taxAmount && args.taxAmount > 0) {
    payload.TxnTaxDetail = { TotalTax: args.taxAmount };
  }
  return payload;
}

export interface QboBillPaymentPayload {
  VendorRef: { value: string };
  TotalAmt: number;
  TxnDate?: string;
  PrivateNote?: string;
  /** PayType + source-account envelope. QBO requires exactly one of
   *  CheckPayment / CreditCardPayment to be set when PayType is set. */
  PayType: 'Check' | 'CreditCard';
  CheckPayment?: { BankAccountRef: { value: string } };
  CreditCardPayment?: { CCAccountRef: { value: string } };
  /** Line is REQUIRED by QBO even for unlinked payments. When no
   *  linkedBillQboId is provided we still send one Line with the Amount
   *  but no LinkedTxn — QBO records it as an unapplied vendor credit. */
  Line: Array<{
    Amount: number;
    LinkedTxn?: Array<{ TxnId: string; TxnType: 'Bill' }>;
  }>;
}

/**
 * Vendor payment (QBO BillPayment). sourceAccountKind controls PayType +
 * which sub-envelope carries the AccountRef. Caller has already classified
 * the local bank account; we don't introspect chartOfAccounts here.
 */
export function serializeBillPaymentToQbo(args: {
  vendorQboId: string;
  amount: number;
  paymentDate?: string | null;
  memo?: string | null;
  sourceAccountQboId: string;
  sourceAccountKind: 'Check' | 'CreditCard';
  linkedBillQboId?: string | null;
}): QboBillPaymentPayload {
  const payload: QboBillPaymentPayload = {
    VendorRef: { value: args.vendorQboId },
    TotalAmt: args.amount,
    PayType: args.sourceAccountKind,
    Line: args.linkedBillQboId
      ? [{ Amount: args.amount, LinkedTxn: [{ TxnId: args.linkedBillQboId, TxnType: 'Bill' }] }]
      : [{ Amount: args.amount }],
  };
  if (args.sourceAccountKind === 'Check') {
    payload.CheckPayment = { BankAccountRef: { value: args.sourceAccountQboId } };
  } else {
    payload.CreditCardPayment = { CCAccountRef: { value: args.sourceAccountQboId } };
  }
  if (args.paymentDate) payload.TxnDate = args.paymentDate;
  if (args.memo) payload.PrivateNote = args.memo;
  return payload;
}
