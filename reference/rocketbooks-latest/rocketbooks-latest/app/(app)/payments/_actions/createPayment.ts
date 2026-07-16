'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { payments, invoices, bills, contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError, buildUnlockCta } from '@/lib/billing/entitlements';
import { enqueueOutbound, fireOutboundDrain, resolveQboId } from '@/lib/qbo/mirror/outbound';
import { serializeBillPaymentToQbo, serializePaymentReceivedToQbo } from '@/lib/qbo/mirror/serializers';
import { logger } from '@/lib/logger';

const Schema = z.object({
  type: z.enum(['received', 'sent']),
  paymentDate: z.iso.date(),
  amount: z.coerce.number().positive(),
  contactId: z.string().min(1),
  bankAccountId: z.string().min(1),
  arApAccountId: z.string().min(1),
  invoiceId: z.string().optional().nullable(),
  billId: z.string().optional().nullable(),
});

export interface CreatePaymentState {
  error?: string;
  unlockProductId?: string;
  unlockLabel?: string;
}

export async function createPayment(_prev: CreatePaymentState | undefined, formData: FormData): Promise<CreatePaymentState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }
  const parsed = Schema.safeParse({
    type: formData.get('type'),
    paymentDate: formData.get('paymentDate'),
    amount: formData.get('amount'),
    contactId: formData.get('contactId'),
    bankAccountId: formData.get('bankAccountId'),
    arApAccountId: formData.get('arApAccountId'),
    invoiceId: formData.get('invoiceId') || null,
    billId: formData.get('billId') || null,
  });
  if (!parsed.success) return { error: 'Invalid input' };

  try {
    await requireDateCovered(orgId, parsed.data.paymentDate);
  } catch (e) {
    if (e instanceof DateNotCoveredError) {
      return { error: e.message, ...(await buildUnlockCta(e)) };
    }
    throw e;
  }

  // Validate
  const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.organizationId, orgId))).limit(1);
  if (!contact) return { error: 'Contact not in this organization' };

  const [bank] = await db.select({ id: chartOfAccounts.id }).from(chartOfAccounts).where(and(eq(chartOfAccounts.id, parsed.data.bankAccountId), eq(chartOfAccounts.organizationId, orgId))).limit(1);
  if (!bank) return { error: 'Bank account not in this organization' };

  const [arAp] = await db.select({ id: chartOfAccounts.id }).from(chartOfAccounts).where(and(eq(chartOfAccounts.id, parsed.data.arApAccountId), eq(chartOfAccounts.organizationId, orgId))).limit(1);
  if (!arAp) return { error: 'AR/AP account not in this organization' };

  if (parsed.data.invoiceId) {
    const [inv] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, parsed.data.invoiceId), eq(invoices.organizationId, orgId))).limit(1);
    if (!inv) return { error: 'Invoice not in this organization' };
  }
  if (parsed.data.billId) {
    const [bill] = await db.select({ id: bills.id }).from(bills).where(and(eq(bills.id, parsed.data.billId), eq(bills.organizationId, orgId))).limit(1);
    if (!bill) return { error: 'Bill not in this organization' };
  }

  const paymentId = randomUUID();
  const memo = parsed.data.type === 'received' ? 'Customer payment' : 'Vendor payment';

  // received: debit bank, credit AR
  // sent:     debit AP, credit bank
  const debitAccount = parsed.data.type === 'received' ? parsed.data.bankAccountId : parsed.data.arApAccountId;
  const creditAccount = parsed.data.type === 'received' ? parsed.data.arApAccountId : parsed.data.bankAccountId;

  // Atomic: payment row + JE in one transaction.
  let queueIds: string[] = [];
  try {
    queueIds = await db.transaction(async (tx) => {
      const result = await createJournalEntry({
        organizationId: orgId,
        date: parsed.data.paymentDate,
        memo,
        posted: true,
        sourceType: 'payment',
        sourceId: paymentId,
        lines: [
          { accountId: debitAccount, debit: parsed.data.amount, credit: 0, contactId: parsed.data.contactId, memo },
          { accountId: creditAccount, debit: 0, credit: parsed.data.amount, contactId: parsed.data.contactId, memo },
        ],
      }, tx);

      await tx.insert(payments).values({
        id: paymentId,
        organizationId: orgId,
        type: parsed.data.type,
        paymentDate: parsed.data.paymentDate,
        amount: parsed.data.amount,
        customerId: parsed.data.type === 'received' ? parsed.data.contactId : null,
        vendorId: parsed.data.type === 'sent' ? parsed.data.contactId : null,
        invoiceId: parsed.data.invoiceId ?? null,
        billId: parsed.data.billId ?? null,
        arAccountId: parsed.data.type === 'received' ? parsed.data.arApAccountId : null,
        apAccountId: parsed.data.type === 'sent' ? parsed.data.arApAccountId : null,
        bankAccountId: parsed.data.bankAccountId,
        journalEntryId: result.id,
      });

      // QBO outbound. type='received' → QBO Payment; type='sent' → QBO
      // BillPayment. Both need the contact mapped + the bank account
      // mapped. LinkedTxn (invoice/bill) is best-effort: when the local
      // linked row hasn't been pushed to QBO yet, we serialize without
      // it and QBO holds the payment as a credit on the customer balance
      // (or unapplied vendor payment).
      const bankQboId = await resolveQboId(tx, orgId, 'account', parsed.data.bankAccountId);
      if (!bankQboId) {
        logger.warn({ paymentId, bankLocalId: parsed.data.bankAccountId }, 'qbo outbound skip: bank account not mapped');
        return [];
      }

      if (parsed.data.type === 'received') {
        const customerQboId = await resolveQboId(tx, orgId, 'customer', parsed.data.contactId);
        if (!customerQboId) {
          logger.warn({ paymentId, customerLocalId: parsed.data.contactId }, 'qbo outbound skip: customer not mapped');
          return [];
        }
        const linkedInvoiceQboId = parsed.data.invoiceId
          ? await resolveQboId(tx, orgId, 'invoice', parsed.data.invoiceId)
          : null;
        const qid = await enqueueOutbound(tx, {
          organizationId: orgId,
          entityType: 'payment',
          localId: paymentId,
          operation: 'create',
          payload: serializePaymentReceivedToQbo({
            customerQboId,
            amount: parsed.data.amount,
            paymentDate: parsed.data.paymentDate,
            depositAccountQboId: bankQboId,
            linkedInvoiceQboId,
          }) as unknown as Record<string, unknown>,
        });
        return qid ? [qid] : [];
      }

      // type === 'sent' → BillPayment. QBO requires LinkedTxn (no
      // "unlinked vendor credit" path via API), so when no billId is
      // supplied we skip the enqueue. The local payment still saves; if
      // the user wants it in QBO they have to attach it to a Bill there.
      if (!parsed.data.billId) {
        logger.info({ paymentId }, 'qbo outbound skip: sent payment without billId — QBO requires LinkedTxn');
        return [];
      }
      const vendorQboId = await resolveQboId(tx, orgId, 'vendor', parsed.data.contactId);
      if (!vendorQboId) {
        logger.warn({ paymentId, vendorLocalId: parsed.data.contactId }, 'qbo outbound skip: vendor not mapped');
        return [];
      }
      const linkedBillQboId = await resolveQboId(tx, orgId, 'bill', parsed.data.billId);
      // Source-of-funds classification: credit_card → CreditCard, anything
      // else (Bank, etc.) → Check. QBO doesn't have separate ACH/wire
      // pay-types; the underlying transaction type is captured downstream
      // in the GL, not in the QBO BillPayment envelope.
      const [bankRow] = await tx
        .select({ accountType: chartOfAccounts.accountType })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, parsed.data.bankAccountId))
        .limit(1);
      const sourceAccountKind: 'Check' | 'CreditCard' = bankRow?.accountType === 'credit_card' ? 'CreditCard' : 'Check';
      const qid = await enqueueOutbound(tx, {
        organizationId: orgId,
        entityType: 'billPayment',
        localId: paymentId,
        operation: 'create',
        payload: serializeBillPaymentToQbo({
          vendorQboId,
          amount: parsed.data.amount,
          paymentDate: parsed.data.paymentDate,
          sourceAccountQboId: bankQboId,
          sourceAccountKind,
          linkedBillQboId,
        }) as unknown as Record<string, unknown>,
      });
      return qid ? [qid] : [];
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await fireOutboundDrain(queueIds);

  revalidatePath('/payments');
  redirect('/payments');
}
