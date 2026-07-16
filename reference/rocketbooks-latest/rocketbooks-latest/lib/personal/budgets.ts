import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalBudgets, personalTransactions } from '@/db/schema/schema';

export interface BudgetWithSpending {
  id: string;
  category: string;
  monthlyLimit: number;
  rollover: boolean;
  /** Spending (money out) for the current month in this category. */
  spentThisMonth: number;
  /** Accumulated unused budget from prior completed months (>= 0). */
  rolloverBalance: number;
  /** What's spendable this month: monthlyLimit + rolloverBalance. */
  available: number;
  /** Persisted AI review of this budget (null until reviewed + applied). */
  aiVerdict: string | null;
  aiProbability: number | null;
  aiNote: string | null;
}

export interface BudgetAiReview {
  verdict: string;
  probability: number;
  note: string;
}

function ymOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Budgets with live spend + rollover computed from transaction history.
 *
 * Spend per (category, month) comes from one grouped query. Rollover for a
 * category accumulates (limit - spent) across every completed month from the
 * budget's creation month up to last month, floored at 0 (unused budget saves;
 * an overspend month can't push the carry negative). The current limit is used
 * for historical months — a reasonable approximation without per-month snapshots.
 */
export async function getBudgetsWithSpending(userId: string, now: Date): Promise<BudgetWithSpending[]> {
  const budgets = await db
    .select({
      id: personalBudgets.id,
      category: personalBudgets.category,
      monthlyLimit: personalBudgets.monthlyLimit,
      rollover: personalBudgets.rollover,
      createdAt: personalBudgets.createdAt,
      aiVerdict: personalBudgets.aiVerdict,
      aiProbability: personalBudgets.aiProbability,
      aiNote: personalBudgets.aiNote,
    })
    .from(personalBudgets)
    .where(eq(personalBudgets.userId, userId))
    .orderBy(personalBudgets.category);
  if (budgets.length === 0) return [];

  const rows = await db
    .select({
      category: personalTransactions.category,
      ym: sql<string>`to_char(date_trunc('month', ${personalTransactions.date}), 'YYYY-MM')`,
      spent: sql<string>`coalesce(sum(case when ${personalTransactions.amount} > 0 then ${personalTransactions.amount} else 0 end), 0)`,
    })
    .from(personalTransactions)
    .where(eq(personalTransactions.userId, userId))
    .groupBy(personalTransactions.category, sql`date_trunc('month', ${personalTransactions.date})`);

  const byCatMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const cat = r.category ?? 'Uncategorized';
    if (!byCatMonth.has(cat)) byCatMonth.set(cat, new Map());
    byCatMonth.get(cat)!.set(r.ym, Number(r.spent));
  }

  const curYm = ymOf(now);
  const curMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  return budgets.map((b) => {
    const limit = Number(b.monthlyLimit);
    const months = byCatMonth.get(b.category) ?? new Map<string, number>();
    const spentThisMonth = months.get(curYm) ?? 0;

    let rolloverBalance = 0;
    if (b.rollover) {
      const start = new Date(b.createdAt);
      const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      // Iterate completed months [creation month, current month).
      while (cursor < curMonthStart) {
        const spent = months.get(ymOf(cursor)) ?? 0;
        rolloverBalance = Math.max(0, rolloverBalance + (limit - spent));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
    }

    return {
      id: b.id,
      category: b.category,
      monthlyLimit: limit,
      rollover: b.rollover,
      spentThisMonth,
      rolloverBalance,
      available: limit + rolloverBalance,
      aiVerdict: b.aiVerdict,
      aiProbability: b.aiProbability,
      aiNote: b.aiNote,
    };
  });
}

/** Categories that already have a budget — used to filter the add picker. */
export async function getBudgetedCategories(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ category: personalBudgets.category })
    .from(personalBudgets)
    .where(eq(personalBudgets.userId, userId));
  return new Set(rows.map((r) => r.category));
}

export async function createBudget(args: {
  userId: string;
  category: string;
  monthlyLimit: number;
  rollover?: boolean;
  ai?: BudgetAiReview | null;
}): Promise<void> {
  const now = new Date().toISOString();
  // When an AI review is attached, persist its take; otherwise leave the AI
  // columns as-is on update (don't wipe a prior review on a plain re-apply).
  const aiSet = args.ai
    ? { aiVerdict: args.ai.verdict, aiProbability: Math.round(args.ai.probability), aiNote: args.ai.note, aiReviewedAt: now }
    : {};
  // No DB unique on (user, category); guard against a duplicate budget for the
  // same category by updating an existing row instead of inserting a second.
  const [existing] = await db
    .select({ id: personalBudgets.id })
    .from(personalBudgets)
    .where(and(eq(personalBudgets.userId, args.userId), eq(personalBudgets.category, args.category)))
    .limit(1);
  if (existing) {
    await db
      .update(personalBudgets)
      .set({ monthlyLimit: String(args.monthlyLimit), rollover: args.rollover ?? false, updatedAt: now, ...aiSet })
      .where(eq(personalBudgets.id, existing.id));
    return;
  }
  await db.insert(personalBudgets).values({
    id: randomUUID(),
    userId: args.userId,
    category: args.category,
    monthlyLimit: String(args.monthlyLimit),
    spent: '0', // vestigial; spend is computed live from transactions
    rollover: args.rollover ?? false,
    aiVerdict: args.ai?.verdict ?? null,
    aiProbability: args.ai ? Math.round(args.ai.probability) : null,
    aiNote: args.ai?.note ?? null,
    aiReviewedAt: args.ai ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateBudget(args: {
  userId: string;
  id: string;
  monthlyLimit?: number;
  rollover?: boolean;
}): Promise<void> {
  // Changing the limit invalidates any stored AI review (it assessed a
  // different number), so clear the annotation when the limit changes.
  const clearAi = args.monthlyLimit !== undefined
    ? { aiVerdict: null, aiProbability: null, aiNote: null, aiReviewedAt: null }
    : {};
  await db
    .update(personalBudgets)
    .set({
      ...(args.monthlyLimit !== undefined ? { monthlyLimit: String(args.monthlyLimit) } : {}),
      ...(args.rollover !== undefined ? { rollover: args.rollover } : {}),
      ...clearAi,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(personalBudgets.id, args.id), eq(personalBudgets.userId, args.userId)));
}

export async function deleteBudget(userId: string, id: string): Promise<void> {
  await db.delete(personalBudgets).where(and(eq(personalBudgets.id, id), eq(personalBudgets.userId, userId)));
}
