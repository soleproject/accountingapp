/**
 * Outstanding-invoice query for the transaction-record "Payment Received
 * for an Invoice" picker. Returns invoices with balance > 0 for an
 * organization, joined to the customer contact, with the balance
 * pre-computed.
 *
 * Mirrors the calculation in /invoices page.tsx (line totals minus
 * applied received-payments).
 */

import { and, asc, eq, isNotNull, ne, or, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { invoices, invoiceLines, contacts, payments } from '@/db/schema/schema';

export interface OutstandingInvoice {
  id: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  contactId: string | null;
  customerName: string | null;
  total: number;
  applied: number;
  balance: number;
}

export async function getOutstandingInvoices(orgId: string): Promise<OutstandingInvoice[]> {
  // Posted invoices that aren't already marked paid, with their gross
  // totals. status can be null on legacy rows so we tolerate that.
  const invRows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      contactId: invoices.contactId,
      customerName: contacts.contactName,
      total: sql<string>`COALESCE(SUM(${invoiceLines.amount}), 0)`,
    })
    .from(invoices)
    .leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(contacts, eq(invoices.contactId, contacts.id))
    .where(
      and(
        eq(invoices.organizationId, orgId),
        eq(invoices.posted, true),
        or(ne(invoices.status, 'paid'), isNull(invoices.status))!,
      ),
    )
    .groupBy(
      invoices.id,
      invoices.invoiceNumber,
      invoices.invoiceDate,
      invoices.dueDate,
      invoices.contactId,
      contacts.contactName,
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.invoiceDate));

  // Received payments applied to invoices — keyed by invoiceId.
  const applied = await db
    .select({ invoiceId: payments.invoiceId, amount: payments.amount })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, orgId),
        eq(payments.type, 'received'),
        isNotNull(payments.invoiceId),
      ),
    );

  const appliedByInvoice = new Map<string, number>();
  for (const p of applied) {
    if (!p.invoiceId) continue;
    appliedByInvoice.set(p.invoiceId, (appliedByInvoice.get(p.invoiceId) ?? 0) + p.amount);
  }

  return invRows
    .map((i) => {
      const total = Number(i.total ?? 0);
      const a = appliedByInvoice.get(i.id) ?? 0;
      const balance = Math.max(0, total - a);
      return {
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate,
        dueDate: i.dueDate,
        contactId: i.contactId,
        customerName: i.customerName,
        total,
        applied: a,
        balance,
      };
    })
    .filter((i) => i.balance > 0);
}
