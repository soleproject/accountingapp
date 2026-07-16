import 'server-only';
import { eq, and, sql, gte, lte, ne, inArray, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  generalLedger,
  chartOfAccounts,
  invoices,
  invoiceLines,
  bills,
  billLines,
} from '@/db/schema/schema';
import type { WindowDays } from './window';
import { generalLedgerBasisFilter, getOrgBasis } from '@/lib/reports/basis-filter';

export type { WindowDays } from './window';
export { VALID_WINDOWS, parseWindow } from './window';

const REVENUE_TYPES = new Set(['revenue', 'income', 'other_income']);
const EXPENSE_TYPES = new Set(['expense', 'cost_of_goods_sold', 'cogs', 'other_expense']);
// Mirrors lib/reports/cash-flow heuristic — cash accounts are identified by
// name keyword, since there's no dedicated `is_cash` flag in the COA.
const CASH_KEYWORDS = ['cash', 'checking', 'savings', 'bank', 'money market', 'venmo', 'paypal'];

export interface DailyRow {
  date: string;
  revenue: number;
  expenses: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
}

export interface ForwardRow {
  date: string;
  scheduledIn: number;
  scheduledOut: number;
  scheduledNet: number;
  extrapolatedNet: number | null;
}

export interface CashSeriesRow {
  date: string;
  /** Realized cash balance, populated for dates ≤ today. */
  actual: number | null;
  /** Cash balance projected from scheduled events only (≥ today). */
  scheduled: number | null;
  /** Cash balance projected with moving-average extrapolation (≥ today). */
  extrapolated: number | null;
  isToday: boolean;
}

export interface AgingBuckets {
  current: number;
  days0_30: number;
  days31_60: number;
  days60Plus: number;
  total: number;
}

export interface PulseData {
  window: {
    days: WindowDays;
    backStart: string;
    today: string;
    forwardEnd: string;
  };
  daily: DailyRow[];
  forwardDaily: ForwardRow[];
  cashSeries: CashSeriesRow[];
  arAging: AgingBuckets;
  apAging: AgingBuckets;
  topCategories: Array<{ name: string; amount: number }>;
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netPL: number;
    totalAr: number;
    totalAp: number;
    cashNow: number;
    projectedCashAtForwardEnd: number;
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

function eachDay(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cursor = startIso;
  while (cursor <= endIso) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * One-shot loader for the /pulse page. Returns every series the page renders
 * in a single payload so the page render is a pure prop-drill, no per-card
 * fetching. Designed to be called from a server component.
 */
export async function loadPulse(args: {
  orgId: string;
  days: WindowDays;
  withExtrapolation: boolean;
}): Promise<PulseData> {
  const { orgId, days, withExtrapolation } = args;
  // Honor the org's reporting basis on the backward GL queries. The cash
  // series (which sums *all-time* GL on cash accounts) intentionally
  // ignores basis — the absolute cash balance has to match reality
  // regardless of how revenue/expense are recognized.
  const basis = await getOrgBasis(orgId);
  const today = isoDay(new Date());
  const backStart = addDays(today, -days);
  const forwardEnd = addDays(today, days);

  // ---------------------------------------------------------------------------
  // Cash account ids — used by cash series and as the "sum of all-time cash GL"
  // anchor for the running balance on `today`.
  // ---------------------------------------------------------------------------
  const allAccounts = await db
    .select({
      id: chartOfAccounts.id,
      name: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      accountType: chartOfAccounts.accountType,
      normalBalance: chartOfAccounts.normalBalance,
    })
    .from(chartOfAccounts)
    .where(eq(chartOfAccounts.organizationId, orgId));

  // Prefer accountType='bank' (canonical) and fall back to the legacy
  // name-keyword heuristic for orgs whose chart hasn't been tagged yet.
  const bankByType = allAccounts.filter((a) => a.accountType === 'bank').map((a) => a.id);
  const cashIds =
    bankByType.length > 0
      ? bankByType
      : allAccounts
          .filter((a) => CASH_KEYWORDS.some((kw) => a.name.toLowerCase().includes(kw)))
          .map((a) => a.id);

  // ---------------------------------------------------------------------------
  // Backward GL: per-day revenue & expense (any account in those gaap types)
  // and cash-account in/out.
  // ---------------------------------------------------------------------------
  const backwardRows = await db
    .select({
      day: sql<string>`TO_CHAR(${generalLedger.date}, 'YYYY-MM-DD')`.as('day'),
      accountId: generalLedger.accountId,
      gaapType: chartOfAccounts.gaapType,
      normalBalance: chartOfAccounts.normalBalance,
      debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('debit'),
      credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('credit'),
    })
    .from(generalLedger)
    .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
    .where(
      and(
        eq(generalLedger.organizationId, orgId),
        gte(generalLedger.date, `${backStart}T00:00:00`),
        lte(generalLedger.date, `${today}T23:59:59`),
        generalLedgerBasisFilter(basis),
      ),
    )
    .groupBy(
      sql`TO_CHAR(${generalLedger.date}, 'YYYY-MM-DD')`,
      generalLedger.accountId,
      chartOfAccounts.gaapType,
      chartOfAccounts.normalBalance,
    );

  // Pre-seed every day in the backward window so charts don't gap-interpolate.
  const dailyByDate = new Map<string, DailyRow>();
  for (const d of eachDay(backStart, today)) {
    dailyByDate.set(d, { date: d, revenue: 0, expenses: 0, cashIn: 0, cashOut: 0, netCash: 0 });
  }

  let totalRevenue = 0;
  let totalExpenses = 0;
  for (const r of backwardRows) {
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    const balance = r.normalBalance === 'debit' ? debit - credit : credit - debit;
    const t = (r.gaapType ?? '').toLowerCase();
    const bucket = dailyByDate.get(r.day);
    if (!bucket) continue;
    if (REVENUE_TYPES.has(t)) {
      bucket.revenue += balance;
      totalRevenue += balance;
    }
    if (EXPENSE_TYPES.has(t)) {
      bucket.expenses += balance;
      totalExpenses += balance;
    }
    if (r.accountId && cashIds.includes(r.accountId)) {
      bucket.cashIn += debit;
      bucket.cashOut += credit;
      bucket.netCash += debit - credit;
    }
  }
  const daily = Array.from(dailyByDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ---------------------------------------------------------------------------
  // Cash balance "now": sum of debit-credit on cash accounts across all-time.
  // We then project a running balance by walking back from today and forward
  // from today using scheduled inflows/outflows.
  // ---------------------------------------------------------------------------
  let cashNow = 0;
  if (cashIds.length > 0) {
    const [cashTotal] = await db
      .select({
        net: sql<string>`COALESCE(SUM(${generalLedger.debit} - ${generalLedger.credit}), 0)`,
      })
      .from(generalLedger)
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          inArray(generalLedger.accountId, cashIds),
          lte(generalLedger.date, `${today}T23:59:59`),
        ),
      );
    cashNow = Number(cashTotal?.net ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Outstanding A/R and A/P, summed per invoice/bill so partial payments don't
  // double-count, then grouped into aging buckets relative to today's date.
  // We also keep per-(due_date) totals for the forward cash projection.
  // ---------------------------------------------------------------------------
  const arRows = await db
    .select({
      id: invoices.id,
      dueDate: invoices.dueDate,
      total: sql<string>`COALESCE(SUM(${invoiceLines.amount}), 0)`,
    })
    .from(invoices)
    .leftJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
    .where(
      and(
        eq(invoices.organizationId, orgId),
        ne(invoices.status, 'paid'),
        eq(invoices.posted, true),
      ),
    )
    .groupBy(invoices.id, invoices.dueDate);

  const apRows = await db
    .select({
      id: bills.id,
      dueDate: bills.dueDate,
      total: sql<string>`COALESCE(SUM(${billLines.amount}), 0)`,
    })
    .from(bills)
    .leftJoin(billLines, eq(billLines.billId, bills.id))
    .where(and(eq(bills.organizationId, orgId), eq(bills.status, 'posted')))
    .groupBy(bills.id, bills.dueDate);

  function toAging(rows: Array<{ dueDate: string | null; total: string }>): AgingBuckets {
    const out: AgingBuckets = { current: 0, days0_30: 0, days31_60: 0, days60Plus: 0, total: 0 };
    for (const r of rows) {
      const amt = Number(r.total);
      if (!Number.isFinite(amt) || amt === 0) continue;
      out.total += amt;
      if (!r.dueDate) {
        out.current += amt;
        continue;
      }
      const daysOverdue = Math.floor(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dueDate}T00:00:00Z`)) / 86_400_000,
      );
      if (daysOverdue <= 0) out.current += amt;
      else if (daysOverdue <= 30) out.days0_30 += amt;
      else if (daysOverdue <= 60) out.days31_60 += amt;
      else out.days60Plus += amt;
    }
    return out;
  }

  const arAging = toAging(arRows);
  const apAging = toAging(apRows);

  // ---------------------------------------------------------------------------
  // Forward scheduled cash flow: A/R due in [today, today+N] are positive
  // inflows; A/P due in the same window are negative outflows. Anything past
  // due is rolled into "today" so the forward chart still reflects it.
  // ---------------------------------------------------------------------------
  const forwardByDate = new Map<string, ForwardRow>();
  for (const d of eachDay(today, forwardEnd)) {
    forwardByDate.set(d, { date: d, scheduledIn: 0, scheduledOut: 0, scheduledNet: 0, extrapolatedNet: null });
  }
  function bucketDueDate(due: string | null): string {
    if (!due || due < today) return today;
    if (due > forwardEnd) return forwardEnd;
    return due;
  }
  for (const r of arRows) {
    const amt = Number(r.total);
    if (!amt) continue;
    const day = bucketDueDate(r.dueDate);
    const b = forwardByDate.get(day);
    if (b) {
      b.scheduledIn += amt;
      b.scheduledNet += amt;
    }
  }
  for (const r of apRows) {
    const amt = Number(r.total);
    if (!amt) continue;
    const day = bucketDueDate(r.dueDate);
    const b = forwardByDate.get(day);
    if (b) {
      b.scheduledOut += amt;
      b.scheduledNet -= amt;
    }
  }

  // Optional moving-average extrapolation: average daily netCash over the
  // backward window (excluding today, which is partial), applied flat across
  // the forward window. Deliberately simple — labeled in the UI as an estimate.
  if (withExtrapolation) {
    const completedDays = daily.filter((d) => d.date < today);
    const avgNet =
      completedDays.length > 0
        ? completedDays.reduce((s, d) => s + d.netCash, 0) / completedDays.length
        : 0;
    for (const row of forwardByDate.values()) {
      // Combine scheduled events with the smoothed baseline so the line
      // reflects both signals rather than picking one.
      row.extrapolatedNet = row.scheduledNet + avgNet;
    }
  }

  const forwardDaily = Array.from(forwardByDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  // ---------------------------------------------------------------------------
  // Unified cash series: one row per day from backStart..forwardEnd, with
  // separate `actual`/`scheduled`/`extrapolated` series so recharts can render
  // them with distinct strokes (solid / dashed / dotted). The scheduled and
  // extrapolated lines start at cashNow on `today` for visual continuity.
  // ---------------------------------------------------------------------------
  const cashSeries: CashSeriesRow[] = [];

  // Backward: walk from today (cashNow) backward subtracting each day's net.
  const backwardBalances = new Map<string, number>();
  let runningBack = cashNow;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i];
    backwardBalances.set(d.date, runningBack);
    runningBack -= d.netCash;
  }

  // Forward: walk from today (cashNow) forward adding each day's scheduled net.
  const scheduledFwd = new Map<string, number>();
  const extrapolatedFwd = new Map<string, number>();
  let runningSched = cashNow;
  let runningExtra = cashNow;
  for (const f of forwardDaily) {
    runningSched += f.scheduledNet;
    scheduledFwd.set(f.date, runningSched);
    if (f.extrapolatedNet != null) {
      runningExtra += f.extrapolatedNet;
      extrapolatedFwd.set(f.date, runningExtra);
    }
  }

  for (const d of eachDay(backStart, forwardEnd)) {
    const isToday = d === today;
    const isBack = d <= today;
    const isFwd = d >= today;
    cashSeries.push({
      date: d,
      actual: isBack ? backwardBalances.get(d) ?? (isToday ? cashNow : null) : null,
      scheduled: isFwd ? scheduledFwd.get(d) ?? (isToday ? cashNow : null) : null,
      extrapolated: withExtrapolation && isFwd ? extrapolatedFwd.get(d) ?? (isToday ? cashNow : null) : null,
      isToday,
    });
  }

  const projectedCashAtForwardEnd =
    cashSeries[cashSeries.length - 1]?.scheduled ?? cashNow;

  // ---------------------------------------------------------------------------
  // Top expense categories over the backward window. Group by COA account name
  // (specific enough to be meaningful, broad enough to bucket repeat charges).
  // ---------------------------------------------------------------------------
  const catRows = await db
    .select({
      accountName: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
      normalBalance: chartOfAccounts.normalBalance,
      debit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`,
      credit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`,
    })
    .from(generalLedger)
    .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
    .where(
      and(
        eq(generalLedger.organizationId, orgId),
        gte(generalLedger.date, `${backStart}T00:00:00`),
        lte(generalLedger.date, `${today}T23:59:59`),
      ),
    )
    .groupBy(
      chartOfAccounts.id,
      chartOfAccounts.accountName,
      chartOfAccounts.gaapType,
      chartOfAccounts.normalBalance,
    )
    .orderBy(asc(chartOfAccounts.accountName));

  const expenseTotals = catRows
    .filter((r) => EXPENSE_TYPES.has((r.gaapType ?? '').toLowerCase()))
    .map((r) => {
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      const balance = r.normalBalance === 'debit' ? debit - credit : credit - debit;
      return { name: r.accountName, amount: balance };
    })
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const topN = 6;
  const topCategories = expenseTotals.slice(0, topN);
  if (expenseTotals.length > topN) {
    const otherAmount = expenseTotals.slice(topN).reduce((s, r) => s + r.amount, 0);
    if (otherAmount > 0) topCategories.push({ name: 'Other', amount: otherAmount });
  }

  return {
    window: { days, backStart, today, forwardEnd },
    daily,
    forwardDaily,
    cashSeries,
    arAging,
    apAging,
    topCategories,
    kpis: {
      totalRevenue,
      totalExpenses,
      netPL: totalRevenue - totalExpenses,
      totalAr: arAging.total,
      totalAp: apAging.total,
      cashNow,
      projectedCashAtForwardEnd,
    },
  };
}
