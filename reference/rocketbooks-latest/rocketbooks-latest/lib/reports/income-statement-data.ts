import 'server-only';
import { eq, and, sql, asc, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, organizations } from '@/db/schema/schema';
import type { IncomeStatementLine } from './income-statement-pdf';
import { generalLedgerBasisFilter, type ReportBasis } from './basis-filter';
import { loadCashBasisSubstitutions } from './cash-basis-substitutions';

export interface IncomeStatementData {
  organizationName: string;
  fromDate: string;
  toDate: string;
  revenue: IncomeStatementLine[];
  otherIncome: IncomeStatementLine[];
  cogs: IncomeStatementLine[];
  operatingExpenses: IncomeStatementLine[];
  otherExpenses: IncomeStatementLine[];
  totals: {
    revenue: number;
    otherIncome: number;
    cogs: number;
    operatingExpenses: number;
    otherExpenses: number;
    grossProfit: number;
    operatingIncome: number;
    netIncome: number;
  };
}

interface BalanceRow {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  accountType: string | null;
  balance: number;
}

const toLine = (r: BalanceRow): IncomeStatementLine => ({
  accountId: r.accountId,
  accountNumber: r.accountNumber ?? '',
  accountName: r.accountName,
  balance: r.balance,
});

const gaap = (r: BalanceRow) => (r.gaapType ?? '').toLowerCase();
const acct = (r: BalanceRow) => (r.accountType ?? '').toLowerCase();

export async function loadIncomeStatement(
  orgId: string,
  fromDate: string,
  toDate: string,
  basis: ReportBasis = 'accrual',
): Promise<IncomeStatementData> {
  const [orgRow, rows] = await Promise.all([
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
        accountType: chartOfAccounts.accountType,
        normalBalance: chartOfAccounts.normalBalance,
        totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('total_debit'),
        totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('total_credit'),
      })
      .from(chartOfAccounts)
      .leftJoin(
        generalLedger,
        and(
          eq(generalLedger.accountId, chartOfAccounts.id),
          eq(generalLedger.organizationId, orgId),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${toDate}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .where(eq(chartOfAccounts.organizationId, orgId))
      .groupBy(
        chartOfAccounts.id,
        chartOfAccounts.accountNumber,
        chartOfAccounts.accountName,
        chartOfAccounts.gaapType,
        chartOfAccounts.accountType,
        chartOfAccounts.normalBalance,
      )
      .orderBy(asc(chartOfAccounts.accountNumber)),
  ]);

  const balances: BalanceRow[] = rows.map((r) => ({
    accountId: r.accountId,
    accountNumber: r.accountNumber,
    accountName: r.accountName,
    gaapType: r.gaapType,
    accountType: r.accountType,
    balance:
      r.normalBalance === 'debit'
        ? Number(r.totalDebit) - Number(r.totalCredit)
        : Number(r.totalCredit) - Number(r.totalDebit),
  }));

  // Cash-basis re-recognition: invoice/bill JEs have been filtered out, so
  // the revenue / expense they would have recognized is missing. Inject it
  // back at payment time, allocated proportionally per invoice/bill line.
  if (basis === 'cash') {
    const subs = await loadCashBasisSubstitutions(orgId, fromDate, toDate);
    for (const sub of subs) {
      let row = balances.find((b) => b.accountId === sub.accountId);
      if (!row) {
        row = {
          accountId: sub.accountId,
          accountNumber: sub.accountNumber,
          accountName: sub.accountName,
          gaapType: sub.gaapType,
          accountType: sub.accountType,
          balance: 0,
        };
        balances.push(row);
      }
      // sub.amount is already in the natural-balance direction for the
      // target account (credit for revenue, debit for expense), so it
      // adds straight to `balance` (which is signed by normalBalance).
      row.balance += sub.amount;
    }
  }

  const nonZero = balances.filter((b) => b.balance !== 0);
  const income = nonZero.filter((b) => gaap(b) === 'income' || gaap(b) === 'revenue');
  const expense = nonZero.filter((b) => gaap(b) === 'expense');

  const revenue = income.filter((b) => acct(b) !== 'other_income').map(toLine);
  const otherIncome = income.filter((b) => acct(b) === 'other_income').map(toLine);

  const cogs = expense
    .filter((b) => acct(b) === 'cost_of_goods_sold' || acct(b) === 'cogs')
    .map(toLine);
  const otherExpenses = expense.filter((b) => acct(b) === 'other_expense').map(toLine);
  const operatingExpenses = expense
    .filter((b) => {
      const a = acct(b);
      return a !== 'cost_of_goods_sold' && a !== 'cogs' && a !== 'other_expense';
    })
    .map(toLine);

  const sum = (lines: IncomeStatementLine[]) => lines.reduce((s, l) => s + l.balance, 0);
  const totalRevenue = sum(revenue);
  const totalOtherIncome = sum(otherIncome);
  const totalCogs = sum(cogs);
  const totalOpEx = sum(operatingExpenses);
  const totalOtherExpenses = sum(otherExpenses);
  const grossProfit = totalRevenue - totalCogs;
  const operatingIncome = grossProfit - totalOpEx;
  const netIncome = operatingIncome + totalOtherIncome - totalOtherExpenses;

  return {
    organizationName: orgRow[0]?.name ?? 'Organization',
    fromDate,
    toDate,
    revenue,
    otherIncome,
    cogs,
    operatingExpenses,
    otherExpenses,
    totals: {
      revenue: totalRevenue,
      otherIncome: totalOtherIncome,
      cogs: totalCogs,
      operatingExpenses: totalOpEx,
      otherExpenses: totalOtherExpenses,
      grossProfit,
      operatingIncome,
      netIncome,
    },
  };
}
