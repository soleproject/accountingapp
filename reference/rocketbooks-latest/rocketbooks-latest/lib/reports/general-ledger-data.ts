import 'server-only';
import { eq, and, asc, desc, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts, contacts, generalLedger, journalEntries, organizations } from '@/db/schema/schema';
import { generalLedgerBasisFilter, type ReportBasis } from './basis-filter';

export interface GeneralLedgerEntry {
  id: string;
  date: string;
  debit: number;
  credit: number;
  memo: string | null;
  contactName: string | null;
  sourceType: string | null;
  sourceId: string | null;
  journalEntryId: string | null;
  jeMemo: string | null;
  runningBalance: number;
}

export interface GeneralLedgerSection {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  normalBalance: 'debit' | 'credit';
  entries: GeneralLedgerEntry[];
  totalDebit: number;
  totalCredit: number;
  /** Sum of running-balance impacts; reconciles to TB for this account. */
  endingBalance: number;
  /** True if this account hit the per-section cap. */
  capped: boolean;
}

export interface GeneralLedgerData {
  organizationName: string;
  fromDate: string;
  toDate: string;
  sections: GeneralLedgerSection[];
  totalDebit: number;
  totalCredit: number;
  /** Echo of the accountId filter, when scoped to a single account. */
  singleAccountId: string | null;
}

/** Per-account row cap on the GL export. Big enough for any realistic period
 *  but keeps the PDF size sane on outlier accounts (high-volume bank). */
const PER_ACCOUNT_LIMIT = 2000;

/**
 * Load GL entries for the period, grouped by account. When `accountId` is set
 * the result contains a single section; otherwise every account with activity
 * in the range is included, ordered by account number.
 */
export async function loadGeneralLedger(
  orgId: string,
  fromDate: string,
  toDate: string,
  accountId?: string | null,
  basis: ReportBasis = 'accrual',
): Promise<GeneralLedgerData> {
  const baseConditions = [
    eq(generalLedger.organizationId, orgId),
    gte(generalLedger.date, `${fromDate}T00:00:00`),
    lte(generalLedger.date, `${toDate}T23:59:59`),
  ];
  if (accountId) baseConditions.push(eq(generalLedger.accountId, accountId));
  const basisFilter = generalLedgerBasisFilter(basis);
  if (basisFilter) baseConditions.push(basisFilter);

  const [orgRow, rows] = await Promise.all([
    db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
    db
      .select({
        id: generalLedger.id,
        date: sql<string>`${generalLedger.date}::date::text`,
        accountId: generalLedger.accountId,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        normalBalance: chartOfAccounts.normalBalance,
        debit: generalLedger.debit,
        credit: generalLedger.credit,
        memo: generalLedger.memo,
        contactName: contacts.contactName,
        journalEntryId: generalLedger.journalEntryId,
        jeMemo: journalEntries.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
        createdAt: generalLedger.createdAt,
      })
      .from(generalLedger)
      .leftJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .leftJoin(contacts, eq(generalLedger.contactId, contacts.id))
      .leftJoin(journalEntries, eq(generalLedger.journalEntryId, journalEntries.id))
      .where(and(...baseConditions))
      .orderBy(asc(chartOfAccounts.accountNumber), asc(generalLedger.date), desc(generalLedger.createdAt)),
  ]);

  // Group rows by account, preserving the date-asc order within each group.
  const byAccount = new Map<
    string,
    {
      accountId: string;
      accountNumber: string | null;
      accountName: string;
      gaapType: string | null;
      normalBalance: 'debit' | 'credit';
      raw: typeof rows;
    }
  >();
  for (const r of rows) {
    // GL rows without an accountId are malformed and have nowhere to land in
    // an account-grouped report. Skip rather than crash.
    if (!r.accountId) continue;
    let g = byAccount.get(r.accountId);
    if (!g) {
      g = {
        accountId: r.accountId,
        accountNumber: r.accountNumber,
        accountName: r.accountName ?? '',
        gaapType: r.gaapType,
        normalBalance: (r.normalBalance ?? 'debit') as 'debit' | 'credit',
        raw: [],
      };
      byAccount.set(r.accountId, g);
    }
    g.raw.push(r);
  }

  const sections: GeneralLedgerSection[] = Array.from(byAccount.values()).map((g) => {
    const isDebitNormal = g.normalBalance === 'debit';
    const sliced = g.raw.slice(0, PER_ACCOUNT_LIMIT);
    let running = 0;
    let totalDebit = 0;
    let totalCredit = 0;
    const entries: GeneralLedgerEntry[] = sliced.map((r) => {
      const debit = Number(r.debit ?? 0);
      const credit = Number(r.credit ?? 0);
      running += isDebitNormal ? debit - credit : credit - debit;
      totalDebit += debit;
      totalCredit += credit;
      return {
        id: r.id,
        date: r.date,
        debit,
        credit,
        memo: r.memo,
        contactName: r.contactName,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        journalEntryId: r.journalEntryId,
        jeMemo: r.jeMemo,
        runningBalance: running,
      };
    });
    return {
      accountId: g.accountId,
      accountNumber: g.accountNumber,
      accountName: g.accountName,
      gaapType: g.gaapType,
      normalBalance: g.normalBalance,
      entries,
      totalDebit,
      totalCredit,
      endingBalance: running,
      capped: g.raw.length > PER_ACCOUNT_LIMIT,
    };
  });

  // Sort by account number (nulls last).
  sections.sort((a, b) => {
    const an = a.accountNumber ?? '';
    const bn = b.accountNumber ?? '';
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    return an.localeCompare(bn);
  });

  const totalDebit = sections.reduce((s, x) => s + x.totalDebit, 0);
  const totalCredit = sections.reduce((s, x) => s + x.totalCredit, 0);

  return {
    organizationName: orgRow[0]?.name ?? 'Organization',
    fromDate,
    toDate,
    sections,
    totalDebit,
    totalCredit,
    singleAccountId: accountId ?? null,
  };
}
