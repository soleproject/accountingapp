import 'server-only';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  bills,
  billLines,
  billPayments,
  billPaymentApplications,
  chartOfAccounts,
  generalLedger,
  invoices,
  invoiceLines,
  invoicePayments,
  invoicePaymentApplications,
} from '@/db/schema/schema';

// Mirror the canonical pattern from app/(app)/reports/income-statement/page.tsx
// exactly — same type lists, same per-account debit/credit normalization,
// same group-by shape. When someone consolidates the duplicated GL aggregation
// across reports into a shared helper, mechanical equivalence matters here.
const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];

const MIN_ORG_HISTORY_DAYS = 7;
const MIN_ACTIVE_DAYS_IN_WINDOW = 3;

const ALLOWED_WINDOWS = [30, 45, 60, 90] as const;
export type OutlookWindow = (typeof ALLOWED_WINDOWS)[number];
export const DEFAULT_OUTLOOK_WINDOW: OutlookWindow = 60;

export function isAllowedOutlookWindow(n: number): n is OutlookWindow {
  return (ALLOWED_WINDOWS as readonly number[]).includes(n);
}

export interface OutlookFlowMetric {
  /** Trailing-window total (real money in/out, last N days). */
  actual: number;
  /** Forward-window projection: scheduled (deterministic open-AR/AP due in window) + extrapolated (background daily rate × N). */
  projected: number;
  /** Decomposition of `projected`. UI may surface this directly later; today the headline number is the sum. */
  projectedBreakdown: {
    /** Sum of open invoices (income) or bills (expenses) due in next N days, billed minus applied. Always known. */
    scheduled: number;
    /** Background daily rate × N. null when notEnoughHistory (extrapolation suppressed). */
    extrapolated: number | null;
  };
  /** Daily aggregates for the trailing window, length = windowDays, oldest first. */
  trailing: number[];
  /** Forward-window daily baseline = extrapolated daily rate. Length = windowDays. Empty when notEnoughHistory. */
  projectedDaily: number[];
  /** True when org age < 7d OR fewer than 3 days had GL activity in the trailing window. Suppresses extrapolation only — scheduled and actual remain. */
  notEnoughHistory: boolean;
}

export interface OutlookStockMetric {
  /** Open balance now (billed − applied), date-agnostic. */
  actual: number;
  /** Sum due in the forward window (billed − applied filtered to due_date in (today, today+N]). */
  projected: number;
}

export interface OutlookData {
  windowDays: number;
  generatedAt: string;
  income: OutlookFlowMetric;
  expenses: OutlookFlowMetric;
  invoices: OutlookStockMetric;
  bills: OutlookStockMetric;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isType(gaapType: string | null | undefined, types: string[]): boolean {
  return types.includes((gaapType ?? '').toLowerCase());
}

// SQL `GROUP BY day` skips empty days. Fill [fromIso, toIso] inclusive with 0
// so the sparkline trend is honest about quiet days instead of compressing
// activity together.
function fillDailySeries(
  rows: { day: string; amount: number }[],
  fromIso: string,
  toIso: string,
): number[] {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.day.slice(0, 10), Number(r.amount) || 0);
  const result: number[] = [];
  const start = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  for (let t = start; t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    result.push(map.get(day) ?? 0);
  }
  return result;
}

/**
 * Compute the Outlook panel's data for an org and window. Pure data-fetching —
 * no auth. Auth and error mapping live at the entry points.
 */
export async function getOutlook(orgId: string, windowDays: OutlookWindow): Promise<OutlookData> {
  const now = new Date();
  const todayIsoStr = isoDate(now);
  const fromDate = isoDate(new Date(now.getTime() - (windowDays - 1) * 86_400_000));
  // Forward window for "due in next N days" is strictly future: (today, today+N].
  // Open balances posted today still count toward `actual` (date-agnostic);
  // projection extrapolates forward from now.
  const futureDate = isoDate(new Date(now.getTime() + windowDays * 86_400_000));

  const [
    coaGlRows,
    incomeDailyRows,
    expenseDailyRows,
    earliestGlRow,
    activeDaysRow,
    invoicesAgg,
    invoicesAppliedAgg,
    billsAgg,
    billsAppliedAgg,
    invoicePaymentDayRows,
    billPaymentDayRows,
  ] = await Promise.all([
    db
      .select({
        gaapType: chartOfAccounts.gaapType,
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
          lte(generalLedger.date, `${todayIsoStr}T23:59:59`),
        ),
      )
      .where(eq(chartOfAccounts.organizationId, orgId))
      .groupBy(chartOfAccounts.id, chartOfAccounts.gaapType, chartOfAccounts.normalBalance),

    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${generalLedger.date}), 'YYYY-MM-DD')`.as('day'),
        amount: sql<number>`COALESCE(SUM(CASE WHEN ${chartOfAccounts.normalBalance} = 'credit' THEN COALESCE(${generalLedger.credit}, 0) - COALESCE(${generalLedger.debit}, 0) ELSE COALESCE(${generalLedger.debit}, 0) - COALESCE(${generalLedger.credit}, 0) END), 0)::float`.as('amount'),
      })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${todayIsoStr}T23:59:59`),
          sql`LOWER(${chartOfAccounts.gaapType}) IN ('revenue','income','other_income')`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${generalLedger.date})`)
      .orderBy(sql`date_trunc('day', ${generalLedger.date})`),

    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${generalLedger.date}), 'YYYY-MM-DD')`.as('day'),
        amount: sql<number>`COALESCE(SUM(CASE WHEN ${chartOfAccounts.normalBalance} = 'debit' THEN COALESCE(${generalLedger.debit}, 0) - COALESCE(${generalLedger.credit}, 0) ELSE COALESCE(${generalLedger.credit}, 0) - COALESCE(${generalLedger.debit}, 0) END), 0)::float`.as('amount'),
      })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${todayIsoStr}T23:59:59`),
          sql`LOWER(${chartOfAccounts.gaapType}) IN ('expense','cost_of_goods_sold','cogs','other_expense')`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${generalLedger.date})`)
      .orderBy(sql`date_trunc('day', ${generalLedger.date})`),

    db
      .select({
        earliest: sql<string | null>`MIN(${generalLedger.date})`.as('earliest'),
      })
      .from(generalLedger)
      .where(eq(generalLedger.organizationId, orgId)),

    db
      .select({
        count: sql<number>`COUNT(DISTINCT date_trunc('day', ${generalLedger.date}))::int`.as('count'),
      })
      .from(generalLedger)
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          gte(generalLedger.date, `${fromDate}T00:00:00`),
          lte(generalLedger.date, `${todayIsoStr}T23:59:59`),
        ),
      ),

    db
      .select({
        billedTotal: sql<number>`COALESCE(SUM(${invoiceLines.amount}), 0)::float`.as('billed_total'),
        billedDueInWindow: sql<number>`COALESCE(SUM(CASE WHEN ${invoices.dueDate} IS NOT NULL AND ${invoices.dueDate} > ${todayIsoStr}::date AND ${invoices.dueDate} <= ${futureDate}::date THEN ${invoiceLines.amount} ELSE 0 END), 0)::float`.as('billed_due_in_window'),
      })
      .from(invoices)
      .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.organizationId, orgId),
          eq(invoices.posted, true),
          ne(invoices.status, 'paid'),
        ),
      ),

    db
      .select({
        appliedTotal: sql<number>`COALESCE(SUM(${invoicePaymentApplications.amountApplied}), 0)::float`.as('applied_total'),
        appliedDueInWindow: sql<number>`COALESCE(SUM(CASE WHEN ${invoices.dueDate} IS NOT NULL AND ${invoices.dueDate} > ${todayIsoStr}::date AND ${invoices.dueDate} <= ${futureDate}::date THEN ${invoicePaymentApplications.amountApplied} ELSE 0 END), 0)::float`.as('applied_due_in_window'),
      })
      .from(invoicePaymentApplications)
      .innerJoin(invoices, eq(invoices.id, invoicePaymentApplications.invoiceId))
      .where(
        and(
          eq(invoices.organizationId, orgId),
          eq(invoices.posted, true),
          ne(invoices.status, 'paid'),
        ),
      ),

    db
      .select({
        billedTotal: sql<number>`COALESCE(SUM(${billLines.amount}), 0)::float`.as('billed_total'),
        billedDueInWindow: sql<number>`COALESCE(SUM(CASE WHEN ${bills.dueDate} IS NOT NULL AND ${bills.dueDate} > ${todayIsoStr}::date AND ${bills.dueDate} <= ${futureDate}::date THEN ${billLines.amount} ELSE 0 END), 0)::float`.as('billed_due_in_window'),
      })
      .from(bills)
      .innerJoin(billLines, eq(billLines.billId, bills.id))
      .where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted'))),

    db
      .select({
        appliedTotal: sql<number>`COALESCE(SUM(${billPaymentApplications.amountApplied}), 0)::float`.as('applied_total'),
        appliedDueInWindow: sql<number>`COALESCE(SUM(CASE WHEN ${bills.dueDate} IS NOT NULL AND ${bills.dueDate} > ${todayIsoStr}::date AND ${bills.dueDate} <= ${futureDate}::date THEN ${billPaymentApplications.amountApplied} ELSE 0 END), 0)::float`.as('applied_due_in_window'),
      })
      .from(billPaymentApplications)
      .innerJoin(bills, eq(bills.id, billPaymentApplications.billId))
      .where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted'))),

    // Days in the trailing window where an invoice payment was applied. These
    // days are excluded from the income extrapolation rate so a single $50K
    // payment-day doesn't inflate the baseline. Joined to applications so that
    // unallocated payments (no application yet) don't drop days that aren't
    // actually offsetting AR.
    db
      .selectDistinct({ day: invoicePayments.paymentDate })
      .from(invoicePayments)
      .innerJoin(
        invoicePaymentApplications,
        eq(invoicePaymentApplications.invoicePaymentId, invoicePayments.id),
      )
      .where(
        and(
          eq(invoicePayments.organizationId, orgId),
          gte(invoicePayments.paymentDate, fromDate),
          lte(invoicePayments.paymentDate, todayIsoStr),
        ),
      ),

    // Same exclusion logic for the expense extrapolation rate.
    db
      .selectDistinct({ day: billPayments.paymentDate })
      .from(billPayments)
      .innerJoin(
        billPaymentApplications,
        eq(billPaymentApplications.billPaymentId, billPayments.id),
      )
      .where(
        and(
          eq(billPayments.organizationId, orgId),
          gte(billPayments.paymentDate, fromDate),
          lte(billPayments.paymentDate, todayIsoStr),
        ),
      ),
  ]);

  // Per-account balances → income/expense totals. Mirrors income-statement.
  const balances = coaGlRows.map((r) => ({
    gaapType: r.gaapType,
    balance:
      r.normalBalance === 'debit'
        ? Number(r.totalDebit) - Number(r.totalCredit)
        : Number(r.totalCredit) - Number(r.totalDebit),
  }));
  const totalIncome = balances
    .filter((b) => isType(b.gaapType, REVENUE_TYPES))
    .reduce((s, b) => s + b.balance, 0);
  const totalExpenses = balances
    .filter((b) => isType(b.gaapType, EXPENSE_TYPES))
    .reduce((s, b) => s + b.balance, 0);

  // notEnoughHistory: brand-new orgs and orgs with sparse trailing activity get
  // a placeholder on the projection side instead of a wild extrapolation. Only
  // suppresses the projection — actuals are real and always shown.
  const earliestStr = earliestGlRow[0]?.earliest ?? null;
  const earliestMs = earliestStr ? new Date(earliestStr).getTime() : null;
  const orgAgeDays =
    earliestMs !== null ? Math.floor((now.getTime() - earliestMs) / 86_400_000) : 0;
  const activeDays = Number(activeDaysRow[0]?.count ?? 0);
  const notEnoughHistory =
    earliestMs === null ||
    orgAgeDays < MIN_ORG_HISTORY_DAYS ||
    activeDays < MIN_ACTIVE_DAYS_IN_WINDOW;

  const incomeTrailing = fillDailySeries(
    incomeDailyRows.map((r) => ({ day: String(r.day), amount: Number(r.amount) })),
    fromDate,
    todayIsoStr,
  );
  const expenseTrailing = fillDailySeries(
    expenseDailyRows.map((r) => ({ day: String(r.day), amount: Number(r.amount) })),
    fromDate,
    todayIsoStr,
  );

  // Open AR/AP. Floating-point can put applied marginally over billed via
  // multiple partial payments — clamp to ≥ 0 so the UI never shows negative
  // open balances.
  const invoiceBilled = Number(invoicesAgg[0]?.billedTotal ?? 0);
  const invoiceBilledDue = Number(invoicesAgg[0]?.billedDueInWindow ?? 0);
  const invoiceApplied = Number(invoicesAppliedAgg[0]?.appliedTotal ?? 0);
  const invoiceAppliedDue = Number(invoicesAppliedAgg[0]?.appliedDueInWindow ?? 0);
  const invoicesActual = Math.max(0, invoiceBilled - invoiceApplied);
  const invoicesProjected = Math.max(0, invoiceBilledDue - invoiceAppliedDue);

  const billBilled = Number(billsAgg[0]?.billedTotal ?? 0);
  const billBilledDue = Number(billsAgg[0]?.billedDueInWindow ?? 0);
  const billApplied = Number(billsAppliedAgg[0]?.appliedTotal ?? 0);
  const billAppliedDue = Number(billsAppliedAgg[0]?.appliedDueInWindow ?? 0);
  const billsActual = Math.max(0, billBilled - billApplied);
  const billsProjected = Math.max(0, billBilledDue - billAppliedDue);

  // Hybrid projection: scheduled (deterministic open-AR/AP due in window) plus
  // extrapolated background rate (daily GL revenue/expense averaged over days
  // that did NOT contain an invoice/bill payment-application event, times N).
  // Excluding payment-application days from the rate avoids letting one big
  // bank-deposit day inflate the baseline; the lump shows up only via the
  // scheduled term, never both.
  const invoicePaymentDays = new Set(
    invoicePaymentDayRows.map((r) => String(r.day).slice(0, 10)),
  );
  const billPaymentDays = new Set(
    billPaymentDayRows.map((r) => String(r.day).slice(0, 10)),
  );

  const incomeBaselineSum = incomeDailyRows
    .filter((r) => !invoicePaymentDays.has(String(r.day).slice(0, 10)))
    .reduce((s, r) => s + Number(r.amount), 0);
  const incomeBaselineDayCount = Math.max(0, windowDays - invoicePaymentDays.size);
  const incomeAvgDaily =
    incomeBaselineDayCount > 0 ? incomeBaselineSum / incomeBaselineDayCount : 0;
  const incomeExtrapolated = notEnoughHistory ? null : incomeAvgDaily * windowDays;
  const incomeProjected = invoicesProjected + (incomeExtrapolated ?? 0);
  const incomeProjectedDaily = notEnoughHistory ? [] : Array(windowDays).fill(incomeAvgDaily);

  const expenseBaselineSum = expenseDailyRows
    .filter((r) => !billPaymentDays.has(String(r.day).slice(0, 10)))
    .reduce((s, r) => s + Number(r.amount), 0);
  const expenseBaselineDayCount = Math.max(0, windowDays - billPaymentDays.size);
  const expenseAvgDaily =
    expenseBaselineDayCount > 0 ? expenseBaselineSum / expenseBaselineDayCount : 0;
  const expenseExtrapolated = notEnoughHistory ? null : expenseAvgDaily * windowDays;
  const expenseProjected = billsProjected + (expenseExtrapolated ?? 0);
  const expenseProjectedDaily = notEnoughHistory ? [] : Array(windowDays).fill(expenseAvgDaily);

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    income: {
      actual: totalIncome,
      projected: incomeProjected,
      projectedBreakdown: {
        scheduled: invoicesProjected,
        extrapolated: incomeExtrapolated,
      },
      trailing: incomeTrailing,
      projectedDaily: incomeProjectedDaily,
      notEnoughHistory,
    },
    expenses: {
      actual: totalExpenses,
      projected: expenseProjected,
      projectedBreakdown: {
        scheduled: billsProjected,
        extrapolated: expenseExtrapolated,
      },
      trailing: expenseTrailing,
      projectedDaily: expenseProjectedDaily,
      notEnoughHistory,
    },
    invoices: { actual: invoicesActual, projected: invoicesProjected },
    bills: { actual: billsActual, projected: billsProjected },
  };
}
