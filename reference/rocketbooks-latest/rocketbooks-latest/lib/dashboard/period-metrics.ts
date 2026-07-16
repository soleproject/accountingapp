import 'server-only';
import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, transactions, contacts } from '@/db/schema/schema';
import { generalLedgerBasisFilter, getOrgBasis } from '@/lib/reports/basis-filter';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];

export interface PeriodMetrics {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  trend: { date: string; revenue: number; expenses: number }[]; // per-month
  totalRevenue: number;
  totalExpenses: number;
  revSeries: number[];
  expSeries: number[];
  nets: number[];
  // Deltas = second half of the range vs first half (null if < 2 months or no base).
  revDelta: number | null;
  expDelta: number | null;
  netDelta: number | null;
  // Range-scoped activity counts + the latest transactions in the range.
  txnCount: number; // transactions dated in range
  contactCount: number; // contacts created in range
  accountCount: number; // distinct accounts with GL activity in range
  recent: { id: string; date: string | null; description: string | null; bankDescription: string | null; amount: number | null }[];
}

/** Enumerate YYYY-MM keys from `from`..`to` (inclusive), oldest first. */
function monthKeys(from: string, to: string): string[] {
  const keys: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7)); // 1-based
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  // guard against pathological ranges
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard < 600) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    guard += 1;
  }
  return keys;
}

/**
 * Per-month revenue/expense over an arbitrary date range, plus totals, sparkline
 * series, and half-over-half deltas. Same GL/basis logic the dashboard's
 * "Last 6 months" block used, generalized so the Custom tab can re-query any range.
 */
export async function getPeriodMetrics(orgId: string, from: string, to: string): Promise<PeriodMetrics> {
  const basis = await getOrgBasis(orgId);

  const [rows, [txnRow], [contactRow], [accountRow], recent] = await Promise.all([
    db
      .select({
        monthKey: sql<string>`TO_CHAR(${generalLedger.date}, 'YYYY-MM')`.as('month_key'),
        gaapType: chartOfAccounts.gaapType,
        normalBalance: chartOfAccounts.normalBalance,
        totalDebit: sql<string>`COALESCE(SUM(${generalLedger.debit}), 0)`.as('total_debit'),
        totalCredit: sql<string>`COALESCE(SUM(${generalLedger.credit}), 0)`.as('total_credit'),
      })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(
        and(
          eq(generalLedger.organizationId, orgId),
          gte(generalLedger.date, `${from}T00:00:00`),
          lte(generalLedger.date, `${to}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .groupBy(sql`TO_CHAR(${generalLedger.date}, 'YYYY-MM')`, chartOfAccounts.gaapType, chartOfAccounts.normalBalance),
    // transactions dated in range
    db.select({ n: count() }).from(transactions).where(and(eq(transactions.organizationId, orgId), gte(transactions.date, from), lte(transactions.date, to))),
    // contacts created in range
    db.select({ n: count() }).from(contacts).where(and(eq(contacts.organizationId, orgId), gte(contacts.createdAt, `${from}T00:00:00`), lte(contacts.createdAt, `${to}T23:59:59`))),
    // distinct accounts with GL activity in range
    db.select({ n: sql<number>`count(distinct ${generalLedger.accountId})::int` }).from(generalLedger).where(and(eq(generalLedger.organizationId, orgId), gte(generalLedger.date, `${from}T00:00:00`), lte(generalLedger.date, `${to}T23:59:59`))),
    // latest transactions in range
    db
      .select({ id: transactions.id, date: transactions.date, description: transactions.description, bankDescription: transactions.bankDescription, amount: transactions.amount })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), gte(transactions.date, from), lte(transactions.date, to)))
      .orderBy(sql`${transactions.date} DESC NULLS LAST`)
      .limit(5),
  ]);

  const byMonth = new Map<string, { revenue: number; expenses: number }>();
  for (const k of monthKeys(from, to)) byMonth.set(k, { revenue: 0, expenses: 0 });
  for (const r of rows) {
    const debit = Number(r.totalDebit);
    const credit = Number(r.totalCredit);
    const balance = r.normalBalance === 'debit' ? debit - credit : credit - debit;
    const t = (r.gaapType ?? '').toLowerCase();
    if (!byMonth.has(r.monthKey)) byMonth.set(r.monthKey, { revenue: 0, expenses: 0 });
    const e = byMonth.get(r.monthKey)!;
    if (REVENUE_TYPES.includes(t)) e.revenue += balance;
    if (EXPENSE_TYPES.includes(t)) e.expenses += balance;
  }

  const trend = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, revenue: v.revenue, expenses: v.expenses }));
  const revSeries = trend.map((t) => t.revenue);
  const expSeries = trend.map((t) => t.expenses);
  const nets = trend.map((t) => t.revenue - t.expenses);
  const totalRevenue = revSeries.reduce((s, n) => s + n, 0);
  const totalExpenses = expSeries.reduce((s, n) => s + n, 0);

  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const pct = (prior: number, last: number): number | null => (prior !== 0 ? ((last - prior) / Math.abs(prior)) * 100 : null);
  const h = Math.floor(trend.length / 2);
  const hasHalves = trend.length >= 2 && h >= 1;
  const revDelta = hasHalves ? pct(sum(revSeries.slice(0, h)), sum(revSeries.slice(h))) : null;
  const expDelta = hasHalves ? pct(sum(expSeries.slice(0, h)), sum(expSeries.slice(h))) : null;
  const netDelta = hasHalves ? pct(sum(nets.slice(0, h)), sum(nets.slice(h))) : null;

  return {
    from, to, trend, totalRevenue, totalExpenses, revSeries, expSeries, nets, revDelta, expDelta, netDelta,
    txnCount: txnRow?.n ?? 0,
    contactCount: contactRow?.n ?? 0,
    accountCount: accountRow?.n ?? 0,
    recent,
  };
}
