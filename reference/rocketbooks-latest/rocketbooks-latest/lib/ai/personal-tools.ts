import 'server-only';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { and, desc, eq, gte, lt, sql, ilike } from 'drizzle-orm';
import { db } from '@/db/client';
import { personalTransactions } from '@/db/schema/schema';
import {
  getPersonalAccounts,
  computeNetWorth,
  getMonthCashflow,
  getSpendByCategory,
  currentMonthStartISO,
} from '@/lib/personal/queries';
import { getBudgetsWithSpending } from '@/lib/personal/budgets';

/**
 * Read-only, user-scoped tools for the Personal product. Exposed to the global
 * AI sidecar via the 'personal' page-tool registry. No mutations — these only
 * query the user's personal finance data and return JSON for the model.
 *
 * Amount convention on personal_transactions: positive = money OUT (spending),
 * negative = money IN (income/credit).
 */
export const PERSONAL_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_personal_overview',
      description:
        "Snapshot of the user's personal finances: net worth (assets minus liabilities), income and spending for the current month, and their top spending categories this month. Use for broad questions like \"how am I doing?\", \"what's my net worth?\", or \"how much have I spent this month?\".",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_personal_spending',
      description:
        'Total spending broken down by category for a time period. Use for "what did I spend on Coffee this month?", "what\'s my biggest spending category?", or "how much did I spend last month?". Optionally filter to one category.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['this_month', 'last_month', 'last_30_days', 'this_year', 'all'],
            description: 'Time period. Defaults to this_month.',
          },
          category: {
            type: 'string',
            description: 'Optional exact category name to filter to (e.g. "Coffee", "Groceries").',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_personal_accounts',
      description:
        "List the user's linked personal accounts (bank, card, loan) with balances, plus total assets, liabilities, and net worth. Use for \"what accounts do I have?\" or \"what's my balance?\".",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_personal_transactions',
      description:
        'Search the user\'s personal transactions with optional filters and return matching rows (newest first, capped) plus the total count and sum. Use for "show my Amazon purchases", "transactions over $100 in Restaurants", or "what did I buy at Costco last month?".',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Exact category name filter.' },
          merchant: { type: 'string', description: 'Merchant/description text to match (partial, case-insensitive).' },
          min_amount: { type: 'number', description: 'Minimum absolute dollar amount.' },
          max_amount: { type: 'number', description: 'Maximum absolute dollar amount.' },
          period: {
            type: 'string',
            enum: ['this_month', 'last_month', 'last_30_days', 'this_year', 'all'],
            description: 'Time period. Defaults to all.',
          },
          limit: { type: 'number', description: 'Max rows to return (1-50, default 20).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_personal_budgets_status',
      description:
        'The user\'s budgets with this month\'s spending vs available (limit plus any rollover) and whether each is over. Use for "am I on track with my budgets?" or "which budgets am I over?".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export const PERSONAL_TOOL_NAMES = new Set(PERSONAL_TOOLS.map((t) => t.function.name));
export function isPersonalToolName(name: string): boolean {
  return PERSONAL_TOOL_NAMES.has(name);
}

interface PeriodRange {
  startISO: string;
  endISO: string | null; // exclusive upper bound; null = up to now
  label: string;
}

function periodRange(period: string | undefined, now: Date): PeriodRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  switch (period) {
    case 'last_month':
      return { startISO: iso(new Date(Date.UTC(y, m - 1, 1))), endISO: iso(new Date(Date.UTC(y, m, 1))), label: 'last month' };
    case 'last_30_days': {
      const s = new Date(now);
      s.setUTCDate(s.getUTCDate() - 30);
      return { startISO: iso(s), endISO: null, label: 'last 30 days' };
    }
    case 'this_year':
      return { startISO: iso(new Date(Date.UTC(y, 0, 1))), endISO: null, label: 'this year' };
    case 'all':
      return { startISO: '1900-01-01', endISO: null, label: 'all time' };
    case 'this_month':
    default:
      return { startISO: iso(new Date(Date.UTC(y, m, 1))), endISO: null, label: 'this month' };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Execute a personal tool. `userId` is resolved by the caller (page-tools via
 * getEffectiveUserId). Returns plain JSON for the model; `{ error }` on failure.
 */
export async function executePersonalTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const now = new Date();

  switch (name) {
    case 'get_personal_overview': {
      const monthStart = currentMonthStartISO(now);
      const [accounts, cashflow, topCats] = await Promise.all([
        getPersonalAccounts(userId),
        getMonthCashflow(userId, monthStart),
        getSpendByCategory(userId, monthStart),
      ]);
      const nw = computeNetWorth(accounts);
      return {
        net_worth: round2(nw.net),
        assets: round2(nw.assets),
        liabilities: round2(nw.liabilities),
        linked_account_count: accounts.length,
        this_month: {
          income: round2(cashflow.income),
          spending: round2(cashflow.spending),
          net: round2(cashflow.net),
        },
        top_spending_categories_this_month: topCats.slice(0, 8).map((c) => ({ category: c.category, spent: round2(c.spent) })),
      };
    }

    case 'get_personal_spending': {
      const { startISO, endISO, label } = periodRange(args.period as string | undefined, now);
      const categoryFilter = typeof args.category === 'string' ? args.category.trim() : '';
      const conds = [
        eq(personalTransactions.userId, userId),
        gte(personalTransactions.date, startISO),
        sql`${personalTransactions.amount} > 0`,
      ];
      if (endISO) conds.push(lt(personalTransactions.date, endISO));
      if (categoryFilter) conds.push(eq(personalTransactions.category, categoryFilter));
      const rows = await db
        .select({
          category: personalTransactions.category,
          spent: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
          count: sql<string>`count(*)`,
        })
        .from(personalTransactions)
        .where(and(...conds))
        .groupBy(personalTransactions.category);
      const cats = rows
        .map((r) => ({ category: r.category ?? 'Uncategorized', spent: round2(Number(r.spent)), count: Number(r.count) }))
        .filter((r) => r.spent > 0)
        .sort((a, b) => b.spent - a.spent);
      const total = round2(cats.reduce((s, c) => s + c.spent, 0));
      return { period: label, total_spent: total, categories: cats };
    }

    case 'list_personal_accounts': {
      const accounts = await getPersonalAccounts(userId);
      const nw = computeNetWorth(accounts);
      return {
        accounts: accounts.map((a) => ({
          name: a.name,
          type: a.type,
          institution: a.institution,
          balance: round2(a.balance),
        })),
        assets: round2(nw.assets),
        liabilities: round2(nw.liabilities),
        net_worth: round2(nw.net),
      };
    }

    case 'search_personal_transactions': {
      const { startISO, endISO } = periodRange((args.period as string | undefined) ?? 'all', now);
      const conds = [eq(personalTransactions.userId, userId), gte(personalTransactions.date, startISO)];
      if (endISO) conds.push(lt(personalTransactions.date, endISO));
      if (typeof args.category === 'string' && args.category.trim()) {
        conds.push(eq(personalTransactions.category, args.category.trim()));
      }
      if (typeof args.merchant === 'string' && args.merchant.trim()) {
        const like = `%${args.merchant.trim()}%`;
        conds.push(sql`(${ilike(personalTransactions.merchant, like)} OR ${ilike(personalTransactions.description, like)})`);
      }
      if (typeof args.min_amount === 'number') conds.push(sql`abs(${personalTransactions.amount}) >= ${args.min_amount}`);
      if (typeof args.max_amount === 'number') conds.push(sql`abs(${personalTransactions.amount}) <= ${args.max_amount}`);

      const limit = Math.max(1, Math.min(50, typeof args.limit === 'number' ? Math.floor(args.limit) : 20));

      const [rows, [agg]] = await Promise.all([
        db
          .select({
            date: personalTransactions.date,
            merchant: personalTransactions.merchant,
            description: personalTransactions.description,
            category: personalTransactions.category,
            amount: personalTransactions.amount,
          })
          .from(personalTransactions)
          .where(and(...conds))
          .orderBy(desc(personalTransactions.date))
          .limit(limit),
        db
          .select({
            count: sql<string>`count(*)`,
            sum: sql<string>`coalesce(sum(${personalTransactions.amount}), 0)`,
          })
          .from(personalTransactions)
          .where(and(...conds)),
      ]);

      return {
        total_matches: Number(agg?.count ?? 0),
        net_amount: round2(Number(agg?.sum ?? 0)),
        note: 'amount: positive = money out (spending), negative = money in',
        showing: rows.length,
        transactions: rows.map((r) => ({
          date: r.date,
          merchant: r.merchant ?? r.description,
          category: r.category ?? 'Uncategorized',
          amount: round2(Number(r.amount)),
        })),
      };
    }

    case 'get_personal_budgets_status': {
      const budgets = await getBudgetsWithSpending(userId, now);
      if (budgets.length === 0) return { budgets: [], note: 'No budgets set up yet.' };
      return {
        budgets: budgets.map((b) => ({
          category: b.category,
          monthly_limit: round2(b.monthlyLimit),
          available_this_month: round2(b.available),
          spent_this_month: round2(b.spentThisMonth),
          remaining: round2(b.available - b.spentThisMonth),
          over_budget: b.spentThisMonth > b.available,
          rollover: b.rollover,
        })),
      };
    }

    default:
      return { error: `Unknown personal tool: ${name}` };
  }
}
