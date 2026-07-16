import { requireSession } from '@/lib/auth/session';
import { getRecurring, scanAndStoreRecurring, hasRecurringRows } from '@/lib/personal/recurring';
import { fmtCurrency } from '@/lib/personal/format';
import { RecurringManager } from './_components/RecurringManager';

export const dynamic = 'force-dynamic';

export default async function PersonalRecurringPage() {
  const user = await requireSession();
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);

  // First visit: run an initial scan so the page isn't empty.
  if (!(await hasRecurringRows(user.id))) {
    await scanAndStoreRecurring(user.id, now);
  }

  const rows = await getRecurring(user.id);
  const expenses = rows.filter((r) => r.type === 'expense');
  const income = rows.filter((r) => r.type === 'income');

  const monthlyExpense = expenses.reduce((s, r) => s + r.monthlyCost, 0);
  const monthlyIncome = income.reduce((s, r) => s + r.monthlyCost, 0);
  const dueSoon = expenses.filter((r) => {
    const days = (new Date(r.nextDate + 'T00:00:00Z').getTime() - new Date(todayISO + 'T00:00:00Z').getTime()) / 86400000;
    return days >= 0 && days <= 7;
  }).length;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Recurring</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Subscriptions and bills detected from your transactions</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Recurring / month</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">{fmtCurrency(monthlyExpense)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Recurring / year</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCurrency(monthlyExpense * 12)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Active subscriptions</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{expenses.length}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Due in 7 days</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{dueSoon}</div>
          {monthlyIncome > 0 && <div className="mt-0.5 text-xs text-zinc-500">+{fmtCurrency(monthlyIncome)}/mo recurring income</div>}
        </div>
      </div>

      <RecurringManager rows={rows} todayISO={todayISO} />
    </div>
  );
}
