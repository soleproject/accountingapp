import { NextRequest, NextResponse } from 'next/server';
import { eq, desc, sql, and, gte, lte, ilike, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { csvRow, CSV_BOM } from '@/lib/csv';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId();
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const q = url.searchParams.get('q');

  const conditions = [eq(transactions.organizationId, orgId)];
  if (from) conditions.push(gte(transactions.date, from));
  if (to) conditions.push(lte(transactions.date, to));
  if (q) {
    conditions.push(
      or(
        ilike(transactions.description, `%${q}%`),
        ilike(transactions.bankDescription, `%${q}%`),
        ilike(transactions.userDescription, `%${q}%`),
      )!,
    );
  }

  const rows = await db
    .select({
      date: transactions.date,
      description: transactions.description,
      bankDescription: transactions.bankDescription,
      userDescription: transactions.userDescription,
      amount: transactions.amount,
      type: transactions.type,
      accountName: chartOfAccounts.accountName,
      contactName: contacts.contactName,
    })
    .from(transactions)
    .leftJoin(chartOfAccounts, eq(transactions.categoryAccountId, chartOfAccounts.id))
    .leftJoin(contacts, eq(transactions.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(sql`${transactions.date} DESC NULLS LAST`, desc(transactions.id))
    .limit(50_000);

  const lines = [csvRow(['date', 'description', 'memo', 'type', 'account', 'contact', 'amount'])];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.date ?? '',
        r.bankDescription ?? r.description ?? '',
        r.userDescription ?? '',
        r.type ?? '',
        r.accountName ?? '',
        r.contactName ?? '',
        r.amount ?? '',
      ]),
    );
  }

  const csv = CSV_BOM + lines.join('\r\n');
  const filename = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
