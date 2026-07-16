import { NextResponse } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { journalEntries, journalEntryLines, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { csvRow, CSV_BOM } from '@/lib/csv';

export async function GET() {
  const orgId = await getCurrentOrgId();
  const rows = await db
    .select({
      jeId: journalEntries.id,
      date: journalEntries.date,
      jeMemo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      lineMemo: journalEntryLines.memo,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
    .where(eq(journalEntries.organizationId, orgId))
    .orderBy(desc(journalEntries.date), sql`${journalEntries.id}`)
    .limit(100_000);

  const lines = [
    csvRow(['je_id', 'date', 'je_memo', 'source', 'account_number', 'account_name', 'line_memo', 'debit', 'credit']),
  ];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.jeId,
        r.date,
        r.jeMemo,
        r.sourceType ?? 'manual',
        r.accountNumber ?? '',
        r.accountName ?? '',
        r.lineMemo ?? '',
        r.debit,
        r.credit,
      ]),
    );
  }
  return new NextResponse(CSV_BOM + lines.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="journal-entries-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
