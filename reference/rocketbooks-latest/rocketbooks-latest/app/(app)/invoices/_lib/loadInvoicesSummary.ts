import { eq, count, desc, and, ne, isNotNull, sql, gte, lte, isNull, or, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { invoices, invoiceLines, contacts, payments } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import type { SQL } from 'drizzle-orm';

const PAGE_SIZE = 50;
const VALID_FILTERS = ['outstanding', 'overdue', 'due30', 'collected_month'] as const;
export type InvoiceFilter = (typeof VALID_FILTERS)[number];

export interface InvoicesSearchParams { page?: string | null; filter?: string | null }

function isoOffset(days: number): string { return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10); }
function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function startOfMonth(): string { return new Date().toISOString().slice(0, 7) + '-01'; }

export async function loadInvoicesSummary(params: InvoicesSearchParams) {
  const orgId = await getCurrentOrgId();
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const filter: InvoiceFilter | null = (VALID_FILTERS as readonly string[]).includes(params.filter ?? '')
    ? (params.filter as InvoiceFilter)
    : null;
  const today = isoToday();
  const in30 = isoOffset(30);
  const monthStart = startOfMonth();

  function filterClause(f: InvoiceFilter | null): SQL | undefined {
    if (!f) return undefined;
    const notPaid = or(ne(invoices.status, 'paid'), isNull(invoices.status))!;
    if (f === 'outstanding') return and(eq(invoices.posted, true), notPaid);
    if (f === 'overdue') return and(eq(invoices.posted, true), notPaid, isNotNull(invoices.dueDate), lt(invoices.dueDate, today));
    if (f === 'due30') return and(eq(invoices.posted, true), notPaid, isNotNull(invoices.dueDate), gte(invoices.dueDate, today), lte(invoices.dueDate, in30));
    return sql`EXISTS (
      SELECT 1 FROM ${payments}
      WHERE ${payments.invoiceId} = ${invoices.id}
        AND ${payments.organizationId} = ${orgId}
        AND ${payments.type} = 'received'
        AND ${payments.paymentDate} >= ${monthStart}
        AND ${payments.paymentDate} <= ${today}
    )`;
  }
  const rowFilter = filterClause(filter);
  const baseWhere = rowFilter ? and(eq(invoices.organizationId, orgId), rowFilter) : eq(invoices.organizationId, orgId);

  const [[total], rows, openInvoiceRows, paymentApplications, [collectedRow]] = await Promise.all([
    db.select({ n: count() }).from(invoices).where(baseWhere),
    db.select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      status: invoices.status,
      posted: invoices.posted,
      memo: invoices.memo,
      contactName: contacts.contactName,
      journalEntryId: invoices.journalEntryId,
      invoiceTotal: sql<string>`(
        SELECT COALESCE(SUM(amount), 0)
        FROM ${invoiceLines}
        WHERE invoice_id = ${invoices.id}
      ) + ${invoices.taxAmount} - ${invoices.discountAmount}`,
    }).from(invoices).leftJoin(contacts, eq(invoices.contactId, contacts.id)).where(baseWhere).orderBy(desc(invoices.invoiceDate), desc(invoices.createdAt)).limit(PAGE_SIZE).offset(offset),
    db.select({
      id: invoices.id,
      dueDate: invoices.dueDate,
      invoiceDate: invoices.invoiceDate,
      total: sql<string>`COALESCE(SUM(${invoiceLines.amount}), 0) + MAX(${invoices.taxAmount}) - MAX(${invoices.discountAmount})`,
    }).from(invoices).leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id)).where(and(eq(invoices.organizationId, orgId), eq(invoices.posted, true), or(ne(invoices.status, 'paid'), isNull(invoices.status))!)).groupBy(invoices.id, invoices.dueDate, invoices.invoiceDate),
    db.select({ invoiceId: payments.invoiceId, amount: payments.amount }).from(payments).where(and(eq(payments.organizationId, orgId), eq(payments.type, 'received'), isNotNull(payments.invoiceId))),
    db.select({ total: sql<string>`COALESCE(SUM(${payments.amount}), 0)` }).from(payments).where(and(eq(payments.organizationId, orgId), eq(payments.type, 'received'), gte(payments.paymentDate, monthStart), lte(payments.paymentDate, today))),
  ]);

  const totalCount = total?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const paidByInvoice = new Map<string, number>();
  for (const p of paymentApplications) if (p.invoiceId) paidByInvoice.set(p.invoiceId, (paidByInvoice.get(p.invoiceId) ?? 0) + p.amount);
  const openInvoices = openInvoiceRows.map((i) => ({ id: i.id, dueDate: i.dueDate, invoiceDate: i.invoiceDate, open: Math.max(0, Number(i.total) - (paidByInvoice.get(i.id) ?? 0)) })).filter((i) => i.open > 0);
  const outstandingTotal = openInvoices.reduce((s, i) => s + i.open, 0);
  const overdueTotal = openInvoices.filter((i) => i.dueDate && i.dueDate < today).reduce((s, i) => s + i.open, 0);
  const dueIn30Total = openInvoices.filter((i) => i.dueDate && i.dueDate >= today && i.dueDate <= in30).reduce((s, i) => s + i.open, 0);
  const collectedThisMonth = Number(collectedRow?.total ?? 0);
  const buckets = { current: 0, b30: 0, b60: 0, b90: 0, b90plus: 0 };
  const todayMs = Date.parse(today);
  for (const i of openInvoices) {
    if (!i.dueDate) buckets.current += i.open;
    else {
      const daysOverdue = Math.floor((todayMs - Date.parse(i.dueDate)) / 86_400_000);
      if (daysOverdue <= 0) buckets.current += i.open;
      else if (daysOverdue <= 30) buckets.b30 += i.open;
      else if (daysOverdue <= 60) buckets.b60 += i.open;
      else if (daysOverdue <= 90) buckets.b90 += i.open;
      else buckets.b90plus += i.open;
    }
  }
  const agingTotal = buckets.current + buckets.b30 + buckets.b60 + buckets.b90 + buckets.b90plus;
  const decoratedRows = rows.map((i) => {
    const grossTotal = Number(i.invoiceTotal ?? 0);
    const applied = paidByInvoice.get(i.id) ?? 0;
    const outstanding = Math.max(0, grossTotal - applied);
    const isOverdue = !!i.dueDate && i.dueDate < today && outstanding > 0;
    return { ...i, invoiceTotal: grossTotal, outstanding, isOverdue, statusLabel: !i.posted ? 'draft' : (i.status ?? 'open') };
  });
  return { page, pageCount, totalCount, filter, today, in30, monthStart, rows: decoratedRows, openCount: openInvoices.length, outstandingTotal, overdueTotal, dueIn30Total, collectedThisMonth, buckets, agingTotal };
}
