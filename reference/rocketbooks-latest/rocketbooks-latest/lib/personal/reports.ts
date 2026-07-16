import 'server-only';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalTransactions, personalCategories } from '@/db/schema/schema';

export type ReportPeriod = 'this_month' | 'last_month' | 'last_30_days' | 'this_year' | 'all';

/** A resolved date window (endISO is exclusive; null = up to now). */
interface Range { startISO: string; endISO: string | null }

/** Range input from the client: a named preset or an explicit custom window. */
export type RangeInput =
  | { kind: 'preset'; period: ReportPeriod }
  | { kind: 'custom'; start: string; end: string };

const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY_MS).toISOString().slice(0, 10);

function presetRange(period: ReportPeriod, now: Date): Range {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  switch (period) {
    case 'last_month':
      return { startISO: iso(new Date(Date.UTC(y, m - 1, 1))), endISO: iso(new Date(Date.UTC(y, m, 1))) };
    case 'last_30_days': {
      const s = new Date(now); s.setUTCDate(s.getUTCDate() - 30);
      return { startISO: iso(s), endISO: null };
    }
    case 'this_year':
      return { startISO: iso(new Date(Date.UTC(y, 0, 1))), endISO: null };
    case 'all':
      return { startISO: '1900-01-01', endISO: null };
    case 'this_month':
    default:
      return { startISO: iso(new Date(Date.UTC(y, m, 1))), endISO: null };
  }
}

export function resolveRange(input: RangeInput, now: Date): Range {
  if (input.kind === 'custom') {
    // Custom end date is inclusive in the UI → exclusive upper bound here.
    const start = input.start || '1900-01-01';
    const end = input.end ? addDays(input.end, 1) : null;
    return { startISO: start, endISO: end };
  }
  return presetRange(input.period, now);
}

function rangeConds(userId: string, range: Range, extra: ReturnType<typeof sql>[] = []) {
  const conds = [eq(personalTransactions.userId, userId), gte(personalTransactions.date, range.startISO), ...extra];
  if (range.endISO) conds.push(lt(personalTransactions.date, range.endISO));
  return conds;
}

export interface CategoryBreakdown {
  total: number;
  categories: { category: string; spent: number; count: number }[];
}

/** Spending (money out) grouped by category for a range, ranked desc. */
export async function getCategoryBreakdown(userId: string, input: RangeInput, now: Date): Promise<CategoryBreakdown> {
  const range = resolveRange(input, now);
  const rows = await db
    .select({
      category: personalTransactions.category,
      spent: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(personalTransactions)
    .where(and(...rangeConds(userId, range, [sql`${personalTransactions.amount} > 0`])))
    .groupBy(personalTransactions.category);
  const categories = rows
    .map((r) => ({ category: r.category ?? 'Uncategorized', spent: Number(r.spent), count: Number(r.count) }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  return { total: categories.reduce((s, c) => s + c.spent, 0), categories };
}

export interface MonthlyTrendPoint { month: string; income: number; expense: number; net: number }

/** Income vs expense per calendar month for the trailing `months` months. */
export async function getMonthlyTrends(userId: string, now: Date, months = 12): Promise<MonthlyTrendPoint[]> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const startISO = start.toISOString().slice(0, 10);
  // Exclude internal transfers (category group 'Transfers') so account-to-account
  // movement doesn't masquerade as income or expense.
  const rows = await db
    .select({
      ym: sql<string>`to_char(date_trunc('month', ${personalTransactions.date}), 'YYYY-MM')`,
      income: sql<string>`coalesce(sum(case when ${personalTransactions.amount} < 0 then -${personalTransactions.amount} else 0 end), 0)`,
      expense: sql<string>`coalesce(sum(case when ${personalTransactions.amount} > 0 then ${personalTransactions.amount} else 0 end), 0)`,
    })
    .from(personalTransactions)
    .leftJoin(
      personalCategories,
      and(eq(personalCategories.userId, personalTransactions.userId), eq(personalCategories.name, personalTransactions.category)),
    )
    .where(and(
      eq(personalTransactions.userId, userId),
      gte(personalTransactions.date, startISO),
      sql`coalesce(${personalCategories.groupName}, '') <> 'Transfers'`,
    ))
    .groupBy(sql`date_trunc('month', ${personalTransactions.date})`);

  const byMonth = new Map(rows.map((r) => [r.ym, { income: Number(r.income), expense: Number(r.expense) }]));
  const out: MonthlyTrendPoint[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const v = byMonth.get(ym) ?? { income: 0, expense: 0 };
    out.push({ month: ym, income: v.income, expense: v.expense, net: v.income - v.expense });
  }
  return out;
}

export interface CategoryDetail {
  category: string;
  total: number;
  count: number;
  byMerchant: { merchant: string; spent: number; count: number }[];
  transactions: { id: string; date: string; merchant: string | null; description: string | null; amount: number }[];
  monthlyTrend: { month: string; spent: number }[];
}

/** Drill-down for one category in a range: by-merchant, transactions, 12mo trend. */
export async function getCategoryDetail(userId: string, input: RangeInput, category: string, now: Date): Promise<CategoryDetail> {
  const range = resolveRange(input, now);
  const catCond = category === 'Uncategorized'
    ? sql`${personalTransactions.category} is null`
    : eq(personalTransactions.category, category);
  const conds = rangeConds(userId, range, [sql`${personalTransactions.amount} > 0`, catCond]);

  // 12-month trend for this category is independent of the selected range.
  const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);

  const [txns, merchantRows, trendRows] = await Promise.all([
    db
      .select({ id: personalTransactions.id, date: personalTransactions.date, merchant: personalTransactions.merchant, description: personalTransactions.description, amount: personalTransactions.amount })
      .from(personalTransactions)
      .where(and(...conds))
      .orderBy(desc(personalTransactions.date))
      .limit(200),
    db
      .select({
        merchant: sql<string>`coalesce(${personalTransactions.merchant}, ${personalTransactions.description}, 'Unknown')`,
        spent: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
        count: sql<string>`count(*)`,
      })
      .from(personalTransactions)
      .where(and(...conds))
      .groupBy(sql`coalesce(${personalTransactions.merchant}, ${personalTransactions.description}, 'Unknown')`),
    db
      .select({
        ym: sql<string>`to_char(date_trunc('month', ${personalTransactions.date}), 'YYYY-MM')`,
        spent: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
      })
      .from(personalTransactions)
      .where(and(eq(personalTransactions.userId, userId), gte(personalTransactions.date, trendStart), sql`${personalTransactions.amount} > 0`, catCond))
      .groupBy(sql`date_trunc('month', ${personalTransactions.date})`),
  ]);

  const byMerchant = merchantRows
    .map((r) => ({ merchant: r.merchant, spent: Number(r.spent), count: Number(r.count) }))
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 12);
  const transactions = txns.map((t) => ({ ...t, amount: Number(t.amount) }));

  const trendMap = new Map(trendRows.map((r) => [r.ym, Number(r.spent)]));
  const monthlyTrend: { month: string; spent: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlyTrend.push({ month: ym, spent: trendMap.get(ym) ?? 0 });
  }

  return {
    category,
    total: transactions.reduce((s, t) => s + t.amount, 0),
    count: transactions.length,
    byMerchant,
    transactions,
    monthlyTrend,
  };
}
