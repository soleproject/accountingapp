import 'server-only';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  personalAccounts,
  personalTransactions,
  personalGoals,
  personalBudgets,
} from '@/db/schema/schema';

/**
 * Liability account subtypes carry a positive balance that represents money
 * OWED, so net worth must subtract them. Plaid emits 'credit' / 'loan'; we also
 * accept a generic 'liability' for manually-added debts.
 */
export const LIABILITY_TYPES = new Set(['credit', 'loan', 'liability']);

export function isLiability(type: string | null | undefined): boolean {
  return LIABILITY_TYPES.has((type ?? '').toLowerCase());
}

export interface PersonalAccountRow {
  id: string;
  name: string;
  type: string;
  balance: number;
  institution: string | null;
  plaidAccountId: string | null;
}

export async function getPersonalAccounts(userId: string): Promise<PersonalAccountRow[]> {
  const rows = await db
    .select({
      id: personalAccounts.id,
      name: personalAccounts.name,
      type: personalAccounts.type,
      balance: personalAccounts.balance,
      institution: personalAccounts.institution,
      plaidAccountId: personalAccounts.plaidAccountId,
    })
    .from(personalAccounts)
    .where(eq(personalAccounts.userId, userId))
    .orderBy(personalAccounts.name);
  return rows.map((r) => ({ ...r, balance: Number(r.balance) }));
}

export interface NetWorth {
  assets: number;
  liabilities: number;
  net: number;
}

/** Split account balances into assets vs liabilities and net them out. */
export function computeNetWorth(accounts: PersonalAccountRow[]): NetWorth {
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (isLiability(a.type)) liabilities += a.balance;
    else assets += a.balance;
  }
  return { assets, liabilities, net: assets - liabilities };
}

export interface PersonalTxnRow {
  id: string;
  date: string;
  amount: number;
  category: string | null;
  description: string | null;
  merchant: string | null;
  accountId: string;
}

export async function getRecentTransactions(userId: string, limit = 25): Promise<PersonalTxnRow[]> {
  const rows = await db
    .select({
      id: personalTransactions.id,
      date: personalTransactions.date,
      amount: personalTransactions.amount,
      category: personalTransactions.category,
      description: personalTransactions.description,
      merchant: personalTransactions.merchant,
      accountId: personalTransactions.accountId,
    })
    .from(personalTransactions)
    .where(eq(personalTransactions.userId, userId))
    .orderBy(desc(personalTransactions.date))
    .limit(limit);
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

export async function getTransactionCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(personalTransactions)
    .where(eq(personalTransactions.userId, userId));
  return row?.n ?? 0;
}

/**
 * Spend grouped by category for the trailing window. Plaid signs amounts so
 * that a positive value is money OUT (spending); we keep that convention on
 * personal_transactions, so spend = sum of positive amounts.
 */
export interface CategorySpend {
  category: string;
  spent: number;
}

export async function getSpendByCategory(userId: string, sinceISO: string): Promise<CategorySpend[]> {
  const rows = await db
    .select({
      category: personalTransactions.category,
      spent: sql<string>`coalesce(sum(case when ${personalTransactions.amount} > 0 then ${personalTransactions.amount} else 0 end), 0)`,
    })
    .from(personalTransactions)
    .where(
      and(
        eq(personalTransactions.userId, userId),
        gte(personalTransactions.date, sinceISO),
      ),
    )
    .groupBy(personalTransactions.category);
  return rows
    .map((r) => ({ category: r.category ?? 'Uncategorized', spent: Number(r.spent) }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent);
}

/** This month's income (money in) and spending (money out). */
export interface MonthCashflow {
  income: number;
  spending: number;
  net: number;
}

export async function getMonthCashflow(userId: string, monthStartISO: string): Promise<MonthCashflow> {
  const [row] = await db
    .select({
      income: sql<string>`coalesce(sum(case when ${personalTransactions.amount} < 0 then -${personalTransactions.amount} else 0 end), 0)`,
      spending: sql<string>`coalesce(sum(case when ${personalTransactions.amount} > 0 then ${personalTransactions.amount} else 0 end), 0)`,
    })
    .from(personalTransactions)
    .where(
      and(
        eq(personalTransactions.userId, userId),
        gte(personalTransactions.date, monthStartISO),
      ),
    );
  const income = Number(row?.income ?? 0);
  const spending = Number(row?.spending ?? 0);
  return { income, spending, net: income - spending };
}

export interface GoalRow {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  targetDate: string | null;
}

export async function getGoals(userId: string): Promise<GoalRow[]> {
  const rows = await db
    .select({
      id: personalGoals.id,
      name: personalGoals.name,
      targetAmount: personalGoals.targetAmount,
      currentAmount: personalGoals.currentAmount,
      targetDate: personalGoals.targetDate,
    })
    .from(personalGoals)
    .where(eq(personalGoals.userId, userId))
    .orderBy(personalGoals.targetDate);
  return rows.map((r) => ({
    ...r,
    targetAmount: Number(r.targetAmount),
    currentAmount: Number(r.currentAmount),
  }));
}

export interface BudgetRow {
  id: string;
  category: string;
  monthlyLimit: number;
  spent: number;
}

export async function getBudgets(userId: string): Promise<BudgetRow[]> {
  const rows = await db
    .select({
      id: personalBudgets.id,
      category: personalBudgets.category,
      monthlyLimit: personalBudgets.monthlyLimit,
      spent: personalBudgets.spent,
    })
    .from(personalBudgets)
    .where(eq(personalBudgets.userId, userId))
    .orderBy(personalBudgets.category);
  return rows.map((r) => ({
    ...r,
    monthlyLimit: Number(r.monthlyLimit),
    spent: Number(r.spent),
  }));
}

/** First day of the current month as an ISO date string (UTC). */
export function currentMonthStartISO(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
