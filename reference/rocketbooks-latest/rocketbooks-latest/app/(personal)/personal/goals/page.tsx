import { requireSession } from '@/lib/auth/session';
import { getGoals } from '@/lib/personal/queries';
import { fmtCurrency } from '@/lib/personal/format';

export const dynamic = 'force-dynamic';

export default async function PersonalGoalsPage() {
  const user = await requireSession();
  const goals = await getGoals(user.id);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Goals</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Savings targets and progress</p>
      </header>

      {goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">No goals yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Set savings goals — an emergency fund, a vacation, a down payment — and track progress here. Goal creation arrives in Phase 2.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((g) => {
            const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100)) : 0;
            return (
              <div key={g.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-xs text-zinc-500">{pct}%</span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {fmtCurrency(g.currentAmount)} of {fmtCurrency(g.targetAmount)}
                  {g.targetDate && <span> · by {g.targetDate}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
