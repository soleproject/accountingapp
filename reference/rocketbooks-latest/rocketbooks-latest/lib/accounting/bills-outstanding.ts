/**
 * Outstanding-bill query for the transaction-record "Payment Sent for a
 * Bill" picker. Returns bills with balance > 0 for an organization,
 * joined to the vendor contact, with the balance pre-computed.
 *
 * Mirrors the calculation in /bills page.tsx (line totals minus applied
 * sent-payments), but pulled into a helper so multiple callers can reuse
 * it without duplicating the SQL.
 */

import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { bills, billLines, contacts, payments } from '@/db/schema/schema';

export interface OutstandingBill {
  id: string;
  billNumber: string | null;
  billDate: string;
  dueDate: string | null;
  contactId: string | null;
  vendorName: string | null;
  total: number;
  applied: number;
  balance: number;
}

export async function getOutstandingBills(orgId: string): Promise<OutstandingBill[]> {
  // Bills posted but not yet flagged paid, with their gross totals.
  const billRows = await db
    .select({
      id: bills.id,
      billNumber: bills.billNumber,
      billDate: bills.billDate,
      dueDate: bills.dueDate,
      contactId: bills.contactId,
      vendorName: contacts.contactName,
      total: sql<string>`COALESCE(SUM(${billLines.amount}), 0)`,
    })
    .from(bills)
    .leftJoin(billLines, eq(billLines.billId, bills.id))
    .leftJoin(contacts, eq(bills.contactId, contacts.id))
    .where(
      and(
        eq(bills.organizationId, orgId),
        eq(bills.status, 'posted'),
        ne(bills.status, 'paid'),
      ),
    )
    .groupBy(bills.id, bills.billNumber, bills.billDate, bills.dueDate, bills.contactId, contacts.contactName)
    .orderBy(asc(bills.dueDate), asc(bills.billDate));

  // Sent payments applied to bills — keyed by billId so we can subtract.
  const applied = await db
    .select({ billId: payments.billId, amount: payments.amount })
    .from(payments)
    .where(
      and(
        eq(payments.organizationId, orgId),
        eq(payments.type, 'sent'),
        isNotNull(payments.billId),
      ),
    );

  const appliedByBill = new Map<string, number>();
  for (const p of applied) {
    if (!p.billId) continue;
    appliedByBill.set(p.billId, (appliedByBill.get(p.billId) ?? 0) + p.amount);
  }

  return billRows
    .map((b) => {
      const total = Number(b.total ?? 0);
      const a = appliedByBill.get(b.id) ?? 0;
      const balance = Math.max(0, total - a);
      return {
        id: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate,
        dueDate: b.dueDate,
        contactId: b.contactId,
        vendorName: b.vendorName,
        total,
        applied: a,
        balance,
      };
    })
    .filter((b) => b.balance > 0);
}
