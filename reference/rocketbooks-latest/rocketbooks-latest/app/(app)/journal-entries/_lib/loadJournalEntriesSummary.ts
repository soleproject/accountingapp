// Server-side journal entries loader used by the page API. Kept separate so
// the document route can stay shell-first while the existing GL query logic
// remains centralized and testable.
import { eq, and, asc, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts, journalEntries, journalEntryLines } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeIsoDate, todayIso, yearStartIso } from '@/lib/reports/dates';

export interface JournalEntriesSearchParams {
  accountId?: string | null;
  from?: string | null;
  to?: string | null;
  reversals?: string | null;
}

export interface DecoratedLine {
  lineId: string;
  jeId: string;
  date: string;
  jeMemo: string | null;
  lineMemo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  accountId: string | null;
  accountNumber: string | null;
  accountName: string | null;
  contactName: string | null;
  debit: number;
  credit: number;
  runningBalance: number | null;
}

type LineRow = Omit<DecoratedLine, 'debit' | 'credit' | 'runningBalance'> & {
  debit: string | number | null;
  credit: string | number | null;
};

function decorateLines(rows: LineRow[], opts: { withRunning: boolean; isDebitNormal: boolean }): DecoratedLine[] {
  let running = 0;
  return rows.map((r) => {
    const debit = Number(r.debit ?? 0);
    const credit = Number(r.credit ?? 0);
    if (opts.withRunning) running += opts.isDebitNormal ? debit - credit : credit - debit;
    return { ...r, debit, credit, runningBalance: opts.withRunning ? running : null };
  });
}

export async function loadJournalEntriesSummary(params: JournalEntriesSearchParams) {
  const orgId = await getCurrentOrgId();
  const accountId = params.accountId || null;
  const fromDate = safeIsoDate(params.from ?? undefined, yearStartIso());
  const toDate = safeIsoDate(params.to ?? undefined, todayIso());
  const showReversals = params.reversals === 'show';

  const accounts = await db
    .select({
      id: chartOfAccounts.id,
      accountNumber: chartOfAccounts.accountNumber,
      accountName: chartOfAccounts.accountName,
      normalBalance: chartOfAccounts.normalBalance,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));

  const selected = accounts.find((a) => a.id === accountId) ?? null;
  const baseConditions = [
    eq(journalEntries.organizationId, orgId),
    gte(journalEntries.date, fromDate),
    lte(journalEntries.date, toDate),
  ];
  if (accountId) baseConditions.push(eq(journalEntryLines.accountId, accountId));
  if (!showReversals) {
    baseConditions.push(sql`${journalEntries.reversalOfId} IS NULL`);
    baseConditions.push(sql`NOT EXISTS (SELECT 1 FROM journal_entries je_rev WHERE je_rev.reversal_of_id = ${journalEntries.id})`);
  }

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        lineId: journalEntryLines.id,
        jeId: journalEntries.id,
        date: journalEntries.date,
        jeMemo: journalEntries.memo,
        lineMemo: journalEntryLines.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        accountId: journalEntryLines.accountId,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        contactName: contacts.contactName,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .leftJoin(chartOfAccounts, eq(journalEntryLines.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(journalEntryLines.contactId, contacts.id))
      .where(and(...baseConditions))
      .orderBy(asc(journalEntries.date), desc(journalEntries.createdAt))
      .limit(100),
    db
      .select({
        debit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`.as('total_debit'),
        credit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`.as('total_credit'),
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(...baseConditions)),
  ]);

  const totalDebitsAll = Number(totals?.debit ?? 0);
  const totalCreditsAll = Number(totals?.credit ?? 0);
  const net = totalDebitsAll - totalCreditsAll;
  const decorated = decorateLines(rows, {
    withRunning: !!selected,
    isDebitNormal: selected?.normalBalance === 'debit',
  });

  return { accounts, selected, fromDate, toDate, showReversals, rows: decorated, totalDebitsAll, totalCreditsAll, net };
}
