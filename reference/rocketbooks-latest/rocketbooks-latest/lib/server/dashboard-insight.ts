import 'server-only';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, chartOfAccounts, organizations } from '@/db/schema/schema';
import { generalLedgerBasisFilter, getOrgBasis } from '@/lib/reports/basis-filter';
import { chatCompletion } from '@/lib/ai/openai';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const EXPENSE_TYPES = ['expense', 'cost_of_goods_sold', 'cogs', 'other_expense'];
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

interface Metrics {
  monthLabel: string;
  prevLabel: string;
  // current month, month-to-date
  curRevenue: number;
  curExpenses: number;
  curNet: number;
  // prior full month, for comparison
  prevRevenue: number;
  prevExpenses: number;
  prevNet: number;
  cashPosition: number;
}

/**
 * Current-month (month-to-date) revenue/expense/net plus the prior full month
 * for comparison, and point-in-time cash. Scoped to the current month because
 * this insight renders on the dashboard's "This month" tab.
 */
async function gatherMetrics(orgId: string): Promise<Metrics> {
  const basis = await getOrgBasis(orgId);
  const today = new Date();
  const y = today.getFullYear();
  const mo = today.getMonth();
  const curKey = `${y}-${String(mo + 1).padStart(2, '0')}`;
  const prevYear = mo === 0 ? y - 1 : y;
  const prevMo = mo === 0 ? 11 : mo - 1;
  const prevKey = `${prevYear}-${String(prevMo + 1).padStart(2, '0')}`;
  const prevStartStr = `${prevKey}-01`;
  const todayStr = today.toISOString().slice(0, 10);
  const monthLabel = new Date(y, mo, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const prevLabel = new Date(prevYear, prevMo, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const [monthRows, [cashRow]] = await Promise.all([
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
      .where(and(eq(generalLedger.organizationId, orgId), gte(generalLedger.date, `${prevStartStr}T00:00:00`), lte(generalLedger.date, `${todayStr}T23:59:59`), generalLedgerBasisFilter(basis)))
      .groupBy(sql`TO_CHAR(${generalLedger.date}, 'YYYY-MM')`, chartOfAccounts.gaapType, chartOfAccounts.normalBalance),
    db
      .select({ bal: sql<string>`COALESCE(SUM(${generalLedger.debit}) - SUM(${generalLedger.credit}), 0)` })
      .from(generalLedger)
      .innerJoin(chartOfAccounts, eq(generalLedger.accountId, chartOfAccounts.id))
      .where(and(eq(generalLedger.organizationId, orgId), eq(chartOfAccounts.accountType, 'bank'))),
  ]);

  const byMonth = new Map<string, { revenue: number; expenses: number }>([
    [curKey, { revenue: 0, expenses: 0 }],
    [prevKey, { revenue: 0, expenses: 0 }],
  ]);
  for (const r of monthRows) {
    const e = byMonth.get(r.monthKey);
    if (!e) continue;
    const balance = r.normalBalance === 'debit' ? Number(r.totalDebit) - Number(r.totalCredit) : Number(r.totalCredit) - Number(r.totalDebit);
    const t = (r.gaapType ?? '').toLowerCase();
    if (REVENUE_TYPES.includes(t)) e.revenue += balance;
    if (EXPENSE_TYPES.includes(t)) e.expenses += balance;
  }
  const cur = byMonth.get(curKey)!;
  const prev = byMonth.get(prevKey)!;

  return {
    monthLabel,
    prevLabel,
    curRevenue: cur.revenue,
    curExpenses: cur.expenses,
    curNet: cur.revenue - cur.expenses,
    prevRevenue: prev.revenue,
    prevExpenses: prev.expenses,
    prevNet: prev.revenue - prev.expenses,
    cashPosition: Number(cashRow?.bal ?? 0),
  };
}

export interface DashboardInsight {
  summary: string;
  headline: string;
  at: string;
}

/**
 * Generate a plain-English "month in review" narrative for the CURRENT month
 * (it renders on the "This month" tab) from this month's MTD financials, last
 * month for comparison, and current cash. Cached on the org. On-demand
 * (button) — not every page load. Grounded: the model is given the exact
 * figures and told not to invent numbers, and to talk about this month only.
 */
export async function generateDashboardInsight(orgId: string, posture?: string): Promise<DashboardInsight> {
  const m = await gatherMetrics(orgId);
  const [org] = await db.select({ name: organizations.name, ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  const facts = [
    `Business: ${org?.name ?? 'the business'}`,
    `This month so far (${m.monthLabel}, month-to-date): revenue ${money(m.curRevenue)}, expenses ${money(m.curExpenses)}, net ${money(m.curNet)}`,
    `Last month for comparison (${m.prevLabel}, full month): revenue ${money(m.prevRevenue)}, expenses ${money(m.prevExpenses)}, net ${money(m.prevNet)}`,
    `Cash on hand right now (bank accounts): ${money(m.cashPosition)}`,
  ].join('\n');

  const system =
    `You are a sharp bookkeeper for a small-business owner. Use ONLY the figures provided — never invent numbers. ` +
    `Write strictly about THE CURRENT MONTH (${m.monthLabel}, month-to-date). You may compare to last month, but do NOT summarize multiple past months or quote multi-month averages. ` +
    `Return strict JSON: ` +
    `{"headline": "<=18 words, the single most important thing about their finances right now, plain and direct>", ` +
    `"summary": "<3-5 sentences about THIS MONTH ONLY: how this month's revenue, expenses, and net are tracking (vs last month where useful) and the cash position; then one final sentence starting with 'Suggested:' giving the single most useful next action. No markdown, no bullets.>"}`;
  const user = `Financials:\n${facts}\n\nReturn the JSON.`;

  let summary = '';
  let headline = '';
  try {
    const c = await chatCompletion(
      { userId: org?.ownerUserId ?? null, orgId, actor: 'system', feature: 'dashboard_insight' },
      { model: process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0.3 },
    );
    const parsed = JSON.parse(c.choices[0]?.message?.content ?? '{}') as { summary?: string; headline?: string };
    summary = (parsed.summary ?? '').trim();
    headline = (parsed.headline ?? '').trim().slice(0, 160);
  } catch (e) {
    console.error('dashboard-insight: generation failed', e);
    throw new Error('Could not generate insights right now.');
  }
  if (!summary) throw new Error('No summary produced.');

  const at = new Date().toISOString();
  await db
    .update(organizations)
    .set({ aiDashboardSummary: summary, aiDashboardSummaryAt: at, aiDashboardHeadline: headline || null, aiDashboardPosture: posture ?? null })
    .where(eq(organizations.id, orgId));
  return { summary, headline, at };
}
