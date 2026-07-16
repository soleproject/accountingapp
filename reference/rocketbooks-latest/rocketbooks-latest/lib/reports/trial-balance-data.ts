import 'server-only';
import { eq, and, sql, asc, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, organizations, journalEntries } from '@/db/schema/schema';
import { generalLedgerBasisFilter, type ReportBasis } from './basis-filter';
import { loadCashBasisSubstitutionsAsOf } from './cash-basis-substitutions';

export interface TrialBalanceRow {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  netDebit: number;
  netCredit: number;
}

export interface TrialBalanceData {
  organizationName: string;
  asOfDate: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/**
 * Load the trial balance for an org as-of a date. Mirrors the on-screen TB
 * exactly — sums debits and credits per chart-of-accounts row through
 * asOfDate, nets them by sign (positive net → debit column, negative →
 * credit column), and filters out zero-balance accounts.
 */
export async function loadTrialBalance(
  orgId: string,
  asOfDate: string,
  basis: ReportBasis = 'accrual',
): Promise<TrialBalanceData> {
  const [orgRow, raw] = await Promise.all([
    db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
    db
      .select({
        accountId: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('total_debit'),
        totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('total_credit'),
      })
      .from(chartOfAccounts)
      .leftJoin(
        generalLedger,
        and(
          eq(generalLedger.accountId, chartOfAccounts.id),
          eq(generalLedger.organizationId, orgId),
          lte(generalLedger.date, `${asOfDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .where(eq(chartOfAccounts.organizationId, orgId))
      .groupBy(
        chartOfAccounts.id,
        chartOfAccounts.accountNumber,
        chartOfAccounts.accountName,
        chartOfAccounts.gaapType,
      )
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  // Carry the raw debit / credit so we can apply cash-basis substitutions
  // before collapsing into a netDebit / netCredit display value.
  type Acc = {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    gaapType: string | null;
    debit: number;
    credit: number;
  };
  const accumulators = new Map<string, Acc>();
  for (const r of raw) {
    accumulators.set(r.accountId, {
      accountId: r.accountId,
      accountNumber: r.accountNumber,
      accountName: r.accountName,
      gaapType: r.gaapType,
      debit: Number(r.totalDebit),
      credit: Number(r.totalCredit),
    });
  }

  if (basis === 'cash') {
    const subs = await loadCashBasisSubstitutionsAsOf(orgId, asOfDate);
    for (const sub of subs) {
      let acc = accumulators.get(sub.accountId);
      if (!acc) {
        acc = {
          accountId: sub.accountId,
          accountNumber: sub.accountNumber,
          accountName: sub.accountName,
          gaapType: sub.gaapType,
          debit: 0,
          credit: 0,
        };
        accumulators.set(sub.accountId, acc);
      }
      if (sub.side === 'debit') acc.debit += sub.amount;
      else acc.credit += sub.amount;
    }
  }

  const rows: TrialBalanceRow[] = Array.from(accumulators.values())
    .map((a) => {
      const net = a.debit - a.credit;
      return {
        accountId: a.accountId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        gaapType: a.gaapType,
        netDebit: Math.max(0, net),
        netCredit: Math.max(0, -net),
      };
    })
    .filter((r) => r.netDebit > 0 || r.netCredit > 0)
    .sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

  const totalDebit = rows.reduce((s, r) => s + r.netDebit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.netCredit, 0);
  const balanced =
    Math.round(totalDebit * 100) === Math.round(totalCredit * 100);

  return {
    organizationName: orgRow[0]?.name ?? 'Organization',
    asOfDate,
    rows,
    totalDebit,
    totalCredit,
    balanced,
  };
}

export interface AdjustedTrialBalanceRow {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  unadjustedDebit: number;
  unadjustedCredit: number;
  adjustmentDebit: number;
  adjustmentCredit: number;
  adjustedDebit: number;
  adjustedCredit: number;
}

export interface AdjustedTrialBalanceData {
  organizationName: string;
  asOfDate: string;
  rows: AdjustedTrialBalanceRow[];
  totals: {
    unadjustedDebit: number;
    unadjustedCredit: number;
    adjustmentDebit: number;
    adjustmentCredit: number;
    adjustedDebit: number;
    adjustedCredit: number;
  };
  balanced: boolean;
}

/**
 * Adjusted trial balance worksheet: per account, the unadjusted balance, the
 * adjusting-entry activity, and the adjusted balance. Splits GL activity by
 * whether the source journal entry is flagged is_adjusting (migration 0120).
 * Cash-basis substitutions are basis conversions, not adjusting entries, so
 * they land in the unadjusted column.
 */
export async function loadAdjustedTrialBalance(
  orgId: string,
  asOfDate: string,
  basis: ReportBasis = 'accrual',
): Promise<AdjustedTrialBalanceData> {
  const [orgRow, raw] = await Promise.all([
    db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    db
      .select({
        accountId: chartOfAccounts.id,
        accountNumber: chartOfAccounts.accountNumber,
        accountName: chartOfAccounts.accountName,
        gaapType: chartOfAccounts.gaapType,
        unadjDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}) FILTER (WHERE ${journalEntries.isAdjusting} IS NOT TRUE), 0)`.as('unadj_debit'),
        unadjCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}) FILTER (WHERE ${journalEntries.isAdjusting} IS NOT TRUE), 0)`.as('unadj_credit'),
        adjDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}) FILTER (WHERE ${journalEntries.isAdjusting} IS TRUE), 0)`.as('adj_debit'),
        adjCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}) FILTER (WHERE ${journalEntries.isAdjusting} IS TRUE), 0)`.as('adj_credit'),
      })
      .from(chartOfAccounts)
      .leftJoin(
        generalLedger,
        and(
          eq(generalLedger.accountId, chartOfAccounts.id),
          eq(generalLedger.organizationId, orgId),
          lte(generalLedger.date, `${asOfDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .leftJoin(journalEntries, eq(journalEntries.id, generalLedger.journalEntryId))
      .where(eq(chartOfAccounts.organizationId, orgId))
      .groupBy(
        chartOfAccounts.id,
        chartOfAccounts.accountNumber,
        chartOfAccounts.accountName,
        chartOfAccounts.gaapType,
      )
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  type Acc = {
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    gaapType: string | null;
    uDebit: number;
    uCredit: number;
    aDebit: number;
    aCredit: number;
  };
  const accumulators = new Map<string, Acc>();
  for (const r of raw) {
    accumulators.set(r.accountId, {
      accountId: r.accountId,
      accountNumber: r.accountNumber,
      accountName: r.accountName,
      gaapType: r.gaapType,
      uDebit: Number(r.unadjDebit),
      uCredit: Number(r.unadjCredit),
      aDebit: Number(r.adjDebit),
      aCredit: Number(r.adjCredit),
    });
  }

  // Cash-basis substitutions adjust the unadjusted (basis-converted) figures.
  if (basis === 'cash') {
    const subs = await loadCashBasisSubstitutionsAsOf(orgId, asOfDate);
    for (const sub of subs) {
      let acc = accumulators.get(sub.accountId);
      if (!acc) {
        acc = {
          accountId: sub.accountId,
          accountNumber: sub.accountNumber,
          accountName: sub.accountName,
          gaapType: sub.gaapType,
          uDebit: 0,
          uCredit: 0,
          aDebit: 0,
          aCredit: 0,
        };
        accumulators.set(sub.accountId, acc);
      }
      if (sub.side === 'debit') acc.uDebit += sub.amount;
      else acc.uCredit += sub.amount;
    }
  }

  const rows: AdjustedTrialBalanceRow[] = Array.from(accumulators.values())
    .map((a) => {
      const uNet = a.uDebit - a.uCredit;
      const adjNet = a.uDebit + a.aDebit - (a.uCredit + a.aCredit);
      return {
        accountId: a.accountId,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        gaapType: a.gaapType,
        unadjustedDebit: Math.max(0, uNet),
        unadjustedCredit: Math.max(0, -uNet),
        adjustmentDebit: a.aDebit,
        adjustmentCredit: a.aCredit,
        adjustedDebit: Math.max(0, adjNet),
        adjustedCredit: Math.max(0, -adjNet),
      };
    })
    .filter(
      (r) =>
        r.unadjustedDebit > 0 ||
        r.unadjustedCredit > 0 ||
        r.adjustmentDebit > 0 ||
        r.adjustmentCredit > 0 ||
        r.adjustedDebit > 0 ||
        r.adjustedCredit > 0,
    )
    .sort((a, b) => (a.accountNumber ?? '').localeCompare(b.accountNumber ?? ''));

  const totals = rows.reduce(
    (t, r) => ({
      unadjustedDebit: t.unadjustedDebit + r.unadjustedDebit,
      unadjustedCredit: t.unadjustedCredit + r.unadjustedCredit,
      adjustmentDebit: t.adjustmentDebit + r.adjustmentDebit,
      adjustmentCredit: t.adjustmentCredit + r.adjustmentCredit,
      adjustedDebit: t.adjustedDebit + r.adjustedDebit,
      adjustedCredit: t.adjustedCredit + r.adjustedCredit,
    }),
    { unadjustedDebit: 0, unadjustedCredit: 0, adjustmentDebit: 0, adjustmentCredit: 0, adjustedDebit: 0, adjustedCredit: 0 },
  );

  return {
    organizationName: orgRow[0]?.name ?? 'Organization',
    asOfDate,
    rows,
    totals,
    balanced: Math.round(totals.adjustedDebit * 100) === Math.round(totals.adjustedCredit * 100),
  };
}
