'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  bills,
  billLines,
  billPayments,
  chartOfAccounts,
  contacts,
  invoices,
  invoiceLines,
  invoicePayments,
  payments,
  qboConflicts,
  qboConnections,
  qboEntityMap,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { qboFetch } from '@/lib/qbo/client';
import { enqueueOutbound, fireOutboundDrain, pickItemQboIdForRevenueAccount, resolveQboId } from '@/lib/qbo/mirror/outbound';
import {
  serializeBillPaymentToQbo,
  serializeBillToQbo,
  serializeChartOfAccountToQbo,
  serializeContactToCustomer,
  serializeContactToVendor,
  serializeInvoiceToQbo,
  serializePaymentReceivedToQbo,
  type BillLineInput,
  type InvoiceLineInput,
} from '@/lib/qbo/mirror/serializers';
import { logger } from '@/lib/logger';

export interface UseLocalStateResult { error?: string }

/**
 * Resolve a conflict by accepting the local side as truth. Refreshes the
 * QBO SyncToken (so the push doesn't 5010 against a stale one), enqueues
 * an outbound update from the current local row, and stamps the conflict
 * resolved. The drain worker handles the actual push asynchronously.
 *
 * Reference entities only (customer, vendor, account). Transactional
 * resolution is a future slice.
 */
export async function applyLocalState(conflictId: string): Promise<UseLocalStateResult | undefined> {
  const orgId = await getCurrentOrgId();
  const session = await requireSession();
  const now = new Date().toISOString();

  const [conflict] = await db
    .select({
      id: qboConflicts.id,
      entityMapId: qboConflicts.entityMapId,
      resolvedAt: qboConflicts.resolvedAt,
      entityType: qboEntityMap.entityType,
      qboId: qboEntityMap.qboId,
      localId: qboEntityMap.localId,
      realmId: qboEntityMap.realmId,
    })
    .from(qboConflicts)
    .innerJoin(qboEntityMap, eq(qboConflicts.entityMapId, qboEntityMap.id))
    .where(and(eq(qboConflicts.id, conflictId), eq(qboConflicts.organizationId, orgId)))
    .limit(1);
  if (!conflict) return { error: 'Conflict not found' };
  if (conflict.resolvedAt) return { error: 'Already resolved' };

  const [connection] = await db
    .select({ id: qboConnections.id })
    .from(qboConnections)
    .where(and(eq(qboConnections.orgId, orgId), eq(qboConnections.realmId, conflict.realmId)))
    .limit(1);
  if (!connection) return { error: 'QuickBooks is no longer connected for this workspace.' };

  // Pull a fresh SyncToken from QBO. We're about to push an Update, and
  // an in-flight inbound change since the original conflict could have
  // advanced QBO's token — using the stale stored token would 5010.
  const fetchSpec: Record<string, { path: string; wrapperKey: string }> = {
    account:     { path: 'account',     wrapperKey: 'Account' },
    customer:    { path: 'customer',    wrapperKey: 'Customer' },
    vendor:      { path: 'vendor',      wrapperKey: 'Vendor' },
    invoice:     { path: 'invoice',     wrapperKey: 'Invoice' },
    bill:        { path: 'bill',        wrapperKey: 'Bill' },
    payment:     { path: 'payment',     wrapperKey: 'Payment' },
    billPayment: { path: 'billpayment', wrapperKey: 'BillPayment' },
  };
  const spec = fetchSpec[conflict.entityType];
  if (!spec) {
    return { error: `Use Ours is not yet supported for ${conflict.entityType}. Use Dismiss after reconciling manually.` };
  }

  let freshSyncToken: string;
  try {
    const envelope = await qboFetch<Record<string, unknown>>(orgId, `/${spec.path}/${conflict.qboId}`);
    const wrap = envelope[spec.wrapperKey] as { SyncToken?: string } | undefined;
    freshSyncToken = wrap?.SyncToken ?? '0';
  } catch (err) {
    return { error: `Failed to fetch SyncToken from QuickBooks: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Load the local row + build the outbound payload via the serializer.
  // For transactional entities we resolve cross-entity refs (vendor /
  // customer / account QBO ids) up-front via entity_map; if any required
  // ref isn't mapped we bail with an error rather than silently shipping
  // an invalid push.
  let payload: Record<string, unknown>;
  if (conflict.entityType === 'account') {
    const [row] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.id, conflict.localId)).limit(1);
    if (!row) return { error: 'Local account no longer exists.' };
    payload = serializeChartOfAccountToQbo(row) as unknown as Record<string, unknown>;
  } else if (conflict.entityType === 'customer' || conflict.entityType === 'vendor') {
    const [row] = await db.select().from(contacts).where(eq(contacts.id, conflict.localId)).limit(1);
    if (!row) return { error: `Local ${conflict.entityType} no longer exists.` };
    payload = conflict.entityType === 'customer'
      ? (serializeContactToCustomer(row) as unknown as Record<string, unknown>)
      : (serializeContactToVendor(row) as unknown as Record<string, unknown>);
  } else if (conflict.entityType === 'invoice') {
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, conflict.localId)).limit(1);
    if (!inv) return { error: 'Local invoice no longer exists.' };
    const customerQboId = await resolveQboId(db, orgId, 'customer', inv.contactId);
    if (!customerQboId) return { error: 'The invoice’s customer isn’t mapped to QBO yet.' };
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, conflict.localId));
    // invoice_lines doesn't carry revenueAccountId in this schema, so the
    // item picker falls back to any mapped item in the org. The
    // resulting QBO invoice may not reflect per-line revenue accounts
    // perfectly — the user can adjust in QBO after the push.
    const lineInputs: InvoiceLineInput[] = [];
    const invTax = Number(inv.taxAmount ?? 0);
    for (const l of lines) {
      const itemQboId = await pickItemQboIdForRevenueAccount(db, orgId, inv.arAccountId ?? '');
      if (!itemQboId) return { error: 'No mapped items in this workspace. Run “Sync items from QBO” on the integrations page first.' };
      lineInputs.push({
        description: l.description,
        amount: Number(l.amount),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        itemQboId,
        taxable: invTax > 0,
      });
    }
    payload = serializeInvoiceToQbo({
      customerQboId,
      docNumber: inv.invoiceNumber,
      txnDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      memo: inv.memo,
      lines: lineInputs,
      discountAmount: Number(inv.discountAmount ?? 0),
      taxAmount: Number(inv.taxAmount ?? 0),
    }) as unknown as Record<string, unknown>;
  } else if (conflict.entityType === 'bill') {
    const [bill] = await db.select().from(bills).where(eq(bills.id, conflict.localId)).limit(1);
    if (!bill) return { error: 'Local bill no longer exists.' };
    const vendorQboId = await resolveQboId(db, orgId, 'vendor', bill.contactId);
    if (!vendorQboId) return { error: 'The bill’s vendor isn’t mapped to QBO yet. Push the vendor first or use Dismiss.' };
    const lines = await db.select().from(billLines).where(eq(billLines.billId, conflict.localId));
    const lineInputs: BillLineInput[] = [];
    for (const l of lines) {
      // bill_lines don't carry an account FK directly in this schema
      // version; the migration's JE captures account splits. Use the
      // org's default expense account fallback so the push completes,
      // and warn so the user can reconcile in QBO if needed.
      const fallback = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.gaapType, 'expense')))
        .limit(1);
      const fallbackId = fallback[0]?.id;
      if (!fallbackId) return { error: 'No expense account available to map bill lines for QBO push.' };
      const accountQboId = await resolveQboId(db, orgId, 'account', fallbackId);
      if (!accountQboId) return { error: 'Default expense account isn’t mapped to QBO. Push it first.' };
      lineInputs.push({
        description: l.description,
        amount: Number(l.amount),
        expenseAccountQboId: accountQboId,
      });
    }
    payload = serializeBillToQbo({
      vendorQboId,
      txnDate: bill.billDate,
      dueDate: bill.dueDate,
      memo: bill.memo,
      lines: lineInputs,
    }) as unknown as Record<string, unknown>;
    if (lines.length > 0) {
      logger.warn({ billId: conflict.localId }, 'qbo use-ours: bill lines pushed with fallback expense account (per-line account FK not tracked)');
    }
  } else if (conflict.entityType === 'payment') {
    // QBO Payment (customer-side). Local row sits in the unified
    // payments table; we pulled type='received' rows here.
    const [pay] = await db.select().from(payments).where(eq(payments.id, conflict.localId)).limit(1);
    if (!pay) {
      // Maybe it's the legacy invoice_payments table (migration-shape).
      const [legacy] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, conflict.localId)).limit(1);
      if (!legacy) return { error: 'Local payment no longer exists.' };
      return { error: 'Use Ours for migration-shape invoice_payments not yet supported. Use Dismiss.' };
    }
    if (pay.type !== 'received' || !pay.customerId) {
      return { error: 'Payment is not a customer payment; nothing to push as QBO Payment.' };
    }
    const customerQboId = await resolveQboId(db, orgId, 'customer', pay.customerId);
    if (!customerQboId) return { error: 'The payment’s customer isn’t mapped to QBO yet.' };
    const depositAccountQboId = pay.bankAccountId
      ? await resolveQboId(db, orgId, 'account', pay.bankAccountId)
      : null;
    const linkedInvoiceQboId = pay.invoiceId
      ? await resolveQboId(db, orgId, 'invoice', pay.invoiceId)
      : null;
    payload = serializePaymentReceivedToQbo({
      customerQboId,
      amount: Number(pay.amount),
      paymentDate: pay.paymentDate,
      depositAccountQboId,
      linkedInvoiceQboId,
    }) as unknown as Record<string, unknown>;
  } else {
    // entityType === 'billPayment'
    const [pay] = await db.select().from(payments).where(eq(payments.id, conflict.localId)).limit(1);
    if (!pay) {
      const [legacy] = await db.select().from(billPayments).where(eq(billPayments.id, conflict.localId)).limit(1);
      if (!legacy) return { error: 'Local bill payment no longer exists.' };
      return { error: 'Use Ours for migration-shape bill_payments not yet supported. Use Dismiss.' };
    }
    if (pay.type !== 'sent' || !pay.vendorId) {
      return { error: 'Payment is not a vendor payment; nothing to push as QBO BillPayment.' };
    }
    if (!pay.billId) {
      return { error: 'QBO BillPayment requires a linked Bill; this payment has none. Use Dismiss after applying it to a bill in QBO.' };
    }
    const vendorQboId = await resolveQboId(db, orgId, 'vendor', pay.vendorId);
    if (!vendorQboId) return { error: 'The payment’s vendor isn’t mapped to QBO yet.' };
    const linkedBillQboId = await resolveQboId(db, orgId, 'bill', pay.billId);
    if (!linkedBillQboId) return { error: 'The linked bill isn’t mapped to QBO yet. Push it first.' };
    if (!pay.bankAccountId) return { error: 'Payment has no bank account; can’t push to QBO.' };
    const sourceAccountQboId = await resolveQboId(db, orgId, 'account', pay.bankAccountId);
    if (!sourceAccountQboId) return { error: 'The bank account isn’t mapped to QBO yet.' };
    const [bankRow] = await db
      .select({ accountType: chartOfAccounts.accountType })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.id, pay.bankAccountId))
      .limit(1);
    const sourceAccountKind: 'Check' | 'CreditCard' = bankRow?.accountType === 'credit_card' ? 'CreditCard' : 'Check';
    payload = serializeBillPaymentToQbo({
      vendorQboId,
      amount: Number(pay.amount),
      paymentDate: pay.paymentDate,
      sourceAccountQboId,
      sourceAccountKind,
      linkedBillQboId,
    }) as unknown as Record<string, unknown>;
  }

  const queueIds = await db.transaction(async (tx) => {
    // Stamp the fresh SyncToken onto the map so the drain reads it.
    await tx
      .update(qboEntityMap)
      .set({ qboSyncToken: freshSyncToken, syncStatus: 'synced', lastError: null, updatedAt: now })
      .where(eq(qboEntityMap.id, conflict.entityMapId));

    const qid = await enqueueOutbound(tx, {
      organizationId: orgId,
      entityType: conflict.entityType as 'account' | 'customer' | 'vendor' | 'invoice' | 'bill' | 'payment' | 'billPayment',
      localId: conflict.localId,
      operation: 'update',
      payload,
    });

    await tx
      .update(qboConflicts)
      .set({ resolution: 'use_ours', resolvedAt: now, resolvedByUserId: session.id, updatedAt: now })
      .where(eq(qboConflicts.id, conflictId));

    const stillOpen = await tx
      .select({ id: qboConflicts.id })
      .from(qboConflicts)
      .where(and(eq(qboConflicts.entityMapId, conflict.entityMapId), isNull(qboConflicts.resolvedAt)))
      .limit(1);
    if (stillOpen.length > 0) {
      await tx
        .update(qboEntityMap)
        .set({ syncStatus: 'conflict', updatedAt: now })
        .where(eq(qboEntityMap.id, conflict.entityMapId));
    }
    return qid ? [qid] : [];
  });

  await fireOutboundDrain(queueIds);

  revalidatePath('/integrations/qbo/conflicts');
  revalidatePath('/integrations/qbo');
  return undefined;
}
