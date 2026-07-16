import Link from 'next/link';
import { eq, count, sql, and, gte, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions, chartOfAccounts, organizations, generalLedger } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getActionCards } from '@/lib/server/action-cards';
import { getOrgMonthlyTimeline } from '@/lib/monthly-timeline';
import { MonthlyTimeline } from '@/components/timeline/MonthlyTimeline';
import { getDailyCashflowThisMonth } from '@/lib/dashboard/daily-cashflow';
import { getPeriodMetrics } from '@/lib/dashboard/period-metrics';
import { CommandCenter } from './CommandCenter';
import { computeDashboardState } from '@/lib/dashboard/posture';
import { generalLedgerBasisFilter, getOrgBasis } from '@/lib/reports/basis-filter';
import { countAllPendingByYear } from '@/lib/billing/plaid-pending';
import { loadArApAging, type AgingBuckets } from '@/lib/reports/ar-ap-aging';

/**
 * The "insights" dashboard — the graph-and-posture command center (cash in/out,
 * runway forecast, month-in-review, AR/AP aging, monthly timeline). It's the
 * alternate view users can toggle to from the default company-snapshot summary.
 * Self-contained: does its own (heavy) data load, so it only runs when selected.
 */

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export async function InsightsDashboard() {
  const orgId = await getCurrentOrgId();

  // Honor the org's reporting basis on the trend chart so the dashboard matches
  // the IS toggle. (Cash basis filters out invoice/bill JEs here.)
  const basis = await getOrgBasis(orgId);
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(today.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  const sixMonthsStr = sixMonthsAgo.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);

  const [[org], [txnCount], monthRows, actionCards, [cashRow], aging, [bankCnt]] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1),
    db.select({ n: count() }).from(transactions).where(eq(transactions.organizationId, orgId)),
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
          gte(generalLedger.date, `${sixMonthsStr}T00:00:00`),
          lte(generalLedger.date, `${todayStr}T23:59:59`),
          generalLedgerBasisFilter(basis),
        ),
      )
      .groupBy(sql`TO_CHAR(${generalLedger.date}, 'YYYY-MM')`, chartOfAccounts.gaapType, chartOfAccounts.normalBalance),
    getActionCards(orgId),
    db
      .select({ bal: sql<string>`COALESCE(SUM(${generalLedger.debit}) - SUM(${generalLedger.credit}), 0)` })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(and(eq(generalLedger.organizationId, orgId), eq(chartOfAccounts.accountType, 'bank'))),
    loadArApAging(orgId),
    db.select({ n: count() }).from(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.accountType, 'bank'))),
  ]);

  const byMonth = new Map<string, { revenue: number; expenses: number }>();
  for (let i = 0; i < 6; i++) {
    const d = new Date(sixMonthsAgo);
    d.setMonth(sixMonthsAgo.getMonth() + i);
    byMonth.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, { revenue: 0, expenses: 0 });
  }
  for (const r of monthRows) {
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
  const totalRevenue = trend.reduce((s, t) => s + t.revenue, 0);
  const totalExpenses = trend.reduce((s, t) => s + t.expenses, 0);

  const cashPosition = Number(cashRow?.bal ?? 0);
  const nets = trend.map((t) => t.revenue - t.expenses);
  const recent3 = nets.slice(-3);
  const avgNet = recent3.length ? recent3.reduce((a, b) => a + b, 0) / recent3.length : 0;
  const burn = avgNet < 0 ? -avgNet : 0;
  const runwayMonths = burn > 0 && cashPosition > 0 ? cashPosition / burn : null;
  const runwayLabel =
    avgNet >= 0 ? 'Profitable' : cashPosition <= 0 ? '—' : runwayMonths! > 99 ? '>99 mo' : `${runwayMonths!.toFixed(1)} mo`;

  const meanNet = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
  const stdev = nets.length ? Math.sqrt(nets.reduce((s, n) => s + (n - meanNet) ** 2, 0) / nets.length) : 0;
  const forecast: { date: string; base: number; best: number; worst: number; range: [number, number] }[] = [
    { date: 'Now', base: Math.round(cashPosition), best: Math.round(cashPosition), worst: Math.round(cashPosition), range: [Math.round(cashPosition), Math.round(cashPosition)] },
  ];
  let baseCash = cashPosition, bestCash = cashPosition, worstCash = cashPosition;
  for (let i = 1; i <= 6; i++) {
    baseCash += avgNet;
    bestCash += avgNet + stdev;
    worstCash += avgNet - stdev;
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    forecast.push({
      date: d.toLocaleDateString('en-US', { month: 'short' }),
      base: Math.round(baseCash),
      best: Math.round(bestCash),
      worst: Math.round(worstCash),
      range: [Math.round(worstCash), Math.round(bestCash)],
    });
  }

  const overdueAr = aging.ar.total - aging.ar.current;
  const overdueAp = aging.ap.total - aging.ap.current;
  const taskCount = actionCards.length;
  const mtdNow = trend[trend.length - 1] ?? { revenue: 0, expenses: 0 };
  const mtdPrev = trend[trend.length - 2] ?? { revenue: 0, expenses: 0 };
  const monthLabel = today.toLocaleDateString('en-US', { month: 'short' });

  const hasCashData = (bankCnt?.n ?? 0) > 0;
  const { posture, defaultPill, headline } = computeDashboardState({
    hasActivity: (txnCount?.n ?? 0) > 0,
    hasCashData,
    cashPosition,
    runwayMonths,
    runwayLabel,
    avgNet,
    net6: totalRevenue - totalExpenses,
    taskCount,
    overdueAr,
    overdueAp,
  });

  const pendingImports = await countAllPendingByYear(orgId);
  const pendingImportsTotal = pendingImports.reduce((s, p) => s + p.count, 0);

  const [monthlyTimeline, cashflow, customInitial] = await Promise.all([
    getOrgMonthlyTimeline(orgId, { requestsHref: '/inbox', communicationsHref: '/inbox' }),
    getDailyCashflowThisMonth(orgId),
    getPeriodMetrics(orgId, sixMonthsStr, todayStr),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">{org?.name ?? 'Dashboard'}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Plan: <strong className="text-zinc-700 dark:text-zinc-300">{org?.planType ?? '—'}</strong> · Method:{' '}
          <strong className="text-zinc-700 dark:text-zinc-300">{org?.accountingMethod ?? '—'}</strong>
        </p>
      </header>

      {pendingImportsTotal > 0 && (
        <Link
          href="/billing"
          className="group flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50"
        >
          <span>
            <strong className="font-medium">{pendingImportsTotal.toLocaleString()}</strong> import{pendingImportsTotal === 1 ? '' : 's'} waiting on a year unlock
            {pendingImports.length <= 3 && <> ({pendingImports.map((p) => p.year).join(', ')})</>}
          </span>
          <span className="text-xs font-medium underline-offset-2 group-hover:underline">Manage in Billing →</span>
        </Link>
      )}

      <CommandCenter
        posture={posture}
        headline={headline}
        aiHeadline={org?.aiDashboardPosture === posture ? org?.aiDashboardHeadline ?? null : null}
        defaultPill={defaultPill}
        cards={actionCards}
        cash={{ cashPosition, runwayLabel, netPerMonth: avgNet, overdueAr, overdueAp, forecast: hasCashData ? forecast : [], cashKnown: hasCashData }}
        month={{
          label: monthLabel,
          rev: mtdNow.revenue,
          exp: mtdNow.expenses,
          net: mtdNow.revenue - mtdNow.expenses,
          prevRev: mtdPrev.revenue,
          prevExp: mtdPrev.expenses,
          prevNet: mtdPrev.revenue - mtdPrev.expenses,
        }}
        cashflow={cashflow}
        custom={customInitial}
        insight={{ summary: org?.aiDashboardSummary ?? null, at: org?.aiDashboardSummaryAt ?? null }}
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgingCard title="Accounts Receivable" subtitle="owed to you" buckets={aging.ar} href="/invoices" tone="emerald" />
        <AgingCard title="Accounts Payable" subtitle="you owe" buckets={aging.ap} href="/bills" tone="amber" />
      </section>

      <MonthlyTimeline steps={monthlyTimeline.steps} periodLabel={monthlyTimeline.period.label} />
    </div>
  );
}

function AgingCard({
  title,
  subtitle,
  buckets,
  href,
  tone,
}: {
  title: string;
  subtitle: string;
  buckets: AgingBuckets;
  href: string;
  tone: 'emerald' | 'amber';
}) {
  const cells = [
    { label: 'Current', v: buckets.current, overdue: false },
    { label: '1–30', v: buckets.d1_30, overdue: true },
    { label: '31–60', v: buckets.d31_60, overdue: true },
    { label: '61–90', v: buckets.d61_90, overdue: true },
    { label: '90+', v: buckets.d90plus, overdue: true },
  ];
  const totalTone = tone === 'emerald' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400';
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</h2>
          <span className="text-[11px] text-zinc-400">{subtitle}</span>
        </div>
        <Link href={href} className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">View →</Link>
      </header>
      <div className={`mb-3 text-2xl font-semibold tabular-nums ${totalTone}`}>{fmt(buckets.total)}</div>
      <div className="grid grid-cols-5 gap-1 text-center">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="text-[10px] uppercase tracking-wide text-zinc-400">{c.label}</div>
            <div className={`mt-0.5 text-xs tabular-nums ${c.overdue && c.v > 0 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
              {c.v > 0 ? fmt(c.v) : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
