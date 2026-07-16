import { requireSession } from '@/lib/auth/session';
import { getBudgetsWithSpending, getBudgetedCategories } from '@/lib/personal/budgets';
import { getPersonalCategories } from '@/lib/personal/categories';
import { fmtCurrency } from '@/lib/personal/format';
import { BudgetManager } from './_components/BudgetManager';
import { BudgetSuggestions } from './_components/BudgetSuggestions';

export const dynamic = 'force-dynamic';

export default async function PersonalBudgetPage() {
  const user = await requireSession();
  const [budgets, budgeted, categories] = await Promise.all([
    getBudgetsWithSpending(user.id, new Date()),
    getBudgetedCategories(user.id),
    getPersonalCategories(user.id),
  ]);

  const addable = categories.map((c) => c.name).filter((name) => !budgeted.has(name));

  const totalBudget = budgets.reduce((s, b) => s + b.available, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spentThisMonth, 0);
  const remaining = totalBudget - totalSpent;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Budget</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Spending limits by category, this month</p>
      </header>

      <BudgetSuggestions />

      {budgets.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Budgeted</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCurrency(totalBudget)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Spent</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCurrency(totalSpent)}</div>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Remaining</div>
            <div className={`mt-1 text-2xl font-semibold tabular-nums ${remaining < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>
              {fmtCurrency(remaining)}
            </div>
          </div>
        </div>
      )}

      <BudgetManager budgets={budgets} addableCategories={addable} />
    </div>
  );
}
