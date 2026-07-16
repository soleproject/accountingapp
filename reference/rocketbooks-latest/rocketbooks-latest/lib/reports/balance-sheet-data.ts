import 'server-only';
import { eq, and, sql, asc, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, organizations } from '@/db/schema/schema';
import { generalLedgerBasisFilter, type ReportBasis } from './basis-filter';
import { loadCashBasisSubstitutionsAsOf } from './cash-basis-substitutions';

export interface BalanceSheetLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  balance: number;
}

export interface BalanceSheetData {
  organizationName: string;
  asOfDate: string;
  currentAssets: BalanceSheetLine[];
  fixedAssets: BalanceSheetLine[];
  otherAssets: BalanceSheetLine[];
  currentLiabilities: BalanceSheetLine[];
  longTermLiabilities: BalanceSheetLine[];
  otherLiabilities: BalanceSheetLine[];
  equity: BalanceSheetLine[];
  netIncome: number;
  totals: {
    currentAssets: number;
    fixedAssets: number;
    otherAssets: number;
    totalAssets: number;
    currentLiabilities: number;
    longTermLiabilities: number;
    otherLiabilities: number;
    totalLiabilities: number;
    equity: number;
    totalLiabilitiesAndEquity: number;
  };
  balanced: boolean;
}

interface BalanceRow {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
  accountType: string | null;
  balance: number;
}

const toLine = (r: BalanceRow): BalanceSheetLine => ({
  accountId: r.accountId,
  accountNumber: r.accountNumber ?? '',
  accountName: r.accountName,
  balance: r.balance,
});

const gaap = (r: BalanceRow) => (r.gaapType ?? '').toLowerCase();
const acct = (r: BalanceRow) => (r.accountType ?? '').toLowerCase();

const CURRENT_ASSET_TYPES = new Set([
  'bank',
  'accounts_receivable',
  'other_current_assets',
  'current_asset',
]);
const FIXED_ASSET_TYPES = new Set(['fixed_assets', 'fixed_asset']);
const CURRENT_LIABILITY_TYPES = new Set([
  'accounts_payable',
  'credit_card',
  'other_current_liabilities',
  'current_liability',
]);
const LONG_TERM_LIABILITY_TYPES = new Set([
  'long_term_liabilities',
  'long_term_liability',
]);

const ASSET_GAAP = new Set(['asset', 'current_asset', 'fixed_asset', 'other_asset']);
const LIABILITY_GAAP = new Set([
  'liability',
  'current_liability',
  'long_term_liability',
  'other_liability',
]);
const EQUITY_GAAP = new Set(['equity']);
const REVENUE_GAAP = new Set(['revenue', 'income', 'other_income']);
const EXPENSE_GAAP = new Set(['expense', 'cost_of_goods_sold', 'cogs', 'other_expense']);

export async function loadBalanceSheet(
  orgId: string,
  asOfDate: string,
  basis: ReportBasis = 'accrual',
): Promise<BalanceSheetData> {
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

  // Cash-basis re-recognition: invoice/bill JEs are filtered out, so we
  // bring back revenue/expense recognition + AR/AP reversal at payment
  // time. AR + AP collapse to zero, revenue/expense flow into Current
  // Year Earnings via the netIncome calc below.
  if (basis === 'cash') {
    const subs = await loadCashBasisSubstitutionsAsOf(orgId, asOfDate);
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
      row.balance += sub.amount;
    }
  }

  const assets = balances.filter((b) => ASSET_GAAP.has(gaap(b)) && b.balance !== 0);
  const liabilities = balances.filter((b) => LIABILITY_GAAP.has(gaap(b)) && b.balance !== 0);
  const equityAccounts = balances.filter((b) => EQUITY_GAAP.has(gaap(b)) && b.balance !== 0);

  // Net Income flows into equity as Current Year Earnings until closing entries
  // roll it into Retained Earnings — without this the BS doesn't balance the
  // moment any P&L activity is posted.
  const totalRevenue = balances
    .filter((b) => REVENUE_GAAP.has(gaap(b)))
    .reduce((s, b) => s + b.balance, 0);
  const totalExpenses = balances
    .filter((b) => EXPENSE_GAAP.has(gaap(b)))
    .reduce((s, b) => s + b.balance, 0);
  const netIncome = totalRevenue - totalExpenses;

  const currentAssets = assets.filter((b) => CURRENT_ASSET_TYPES.has(acct(b))).map(toLine);
  const fixedAssets = assets.filter((b) => FIXED_ASSET_TYPES.has(acct(b))).map(toLine);
  const otherAssets = assets
    .filter((b) => !CURRENT_ASSET_TYPES.has(acct(b)) && !FIXED_ASSET_TYPES.has(acct(b)))
    .map(toLine);

  const currentLiabilities = liabilities
    .filter((b) => CURRENT_LIABILITY_TYPES.has(acct(b)))
    .map(toLine);
  const longTermLiabilities = liabilities
    .filter((b) => LONG_TERM_LIABILITY_TYPES.has(acct(b)))
    .map(toLine);
  const otherLiabilities = liabilities
    .filter(
      (b) =>
        !CURRENT_LIABILITY_TYPES.has(acct(b)) && !LONG_TERM_LIABILITY_TYPES.has(acct(b)),
    )
    .map(toLine);

  const equity: BalanceSheetLine[] = equityAccounts.map(toLine);
  if (Math.round(netIncome * 100) !== 0) {
    equity.push({
      accountId: '__current_year_earnings__',
      accountNumber: '',
      accountName: 'Current Year Earnings',
      balance: netIncome,
    });
  }

  const sum = (lines: BalanceSheetLine[]) => lines.reduce((s, l) => s + l.balance, 0);
  const totalCurrentAssets = sum(currentAssets);
  const totalFixedAssets = sum(fixedAssets);
  const totalOtherAssets = sum(otherAssets);
  const totalAssets = totalCurrentAssets + totalFixedAssets + totalOtherAssets;
  const totalCurrentLiabilities = sum(currentLiabilities);
  const totalLongTermLiabilities = sum(longTermLiabilities);
  const totalOtherLiabilities = sum(otherLiabilities);
  const totalLiabilities =
    totalCurrentLiabilities + totalLongTermLiabilities + totalOtherLiabilities;
  const totalEquity = sum(equity);
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;
  const balanced =
    Math.round(totalAssets * 100) === Math.round(totalLiabilitiesAndEquity * 100);

  return {
    organizationName: orgRow[0]?.name ?? 'Organization',
    asOfDate,
    currentAssets,
    fixedAssets,
    otherAssets,
    currentLiabilities,
    longTermLiabilities,
    otherLiabilities,
    equity,
    netIncome,
    totals: {
      currentAssets: totalCurrentAssets,
      fixedAssets: totalFixedAssets,
      otherAssets: totalOtherAssets,
      totalAssets,
      currentLiabilities: totalCurrentLiabilities,
      longTermLiabilities: totalLongTermLiabilities,
      otherLiabilities: totalOtherLiabilities,
      totalLiabilities,
      equity: totalEquity,
      totalLiabilitiesAndEquity,
    },
    balanced,
  };
}
