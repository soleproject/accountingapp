import { requireSession } from '@/lib/auth/session';
import { getCashflowProjection } from '@/lib/personal/cashflow';
import { fmtCurrency } from '@/lib/personal/format';
import { CashflowChart } from './_components/CashflowChart';

export const dynamic = 'force-dynamic';

export default async function PersonalCashflowPage() {
  const user = await requireSession();
  const cf = await getCashflowProjection(user.id, new Date());

  const remainingDays = cf.daysInMonth - cf.today;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Cash Flow</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Money in vs money out — {cf.monthLabel}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Income (MTD)</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCurrency(cf.monthToDate.income)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Spending (MTD)</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">{fmtCurrency(cf.monthToDate.spending)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Net (MTD)</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${cf.monthToDate.net < 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{fmtCurrency(cf.monthToDate.net)}</div>
        </div>
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 dark:border-sky-900/50 dark:bg-sky-950/30">
          <div className="text-xs uppercase tracking-wide text-sky-700 dark:text-sky-300">Projected month-end cash</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCurrency(cf.projectedMonthEndBalance)}</div>
          <div className="mt-0.5 text-xs text-sky-700/70 dark:text-sky-300/70">
            {remainingDays > 0 ? `est. over ${remainingDays} day${remainingDays === 1 ? '' : 's'} left` : 'month complete'}
          </div>
        </div>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Running cash balance</h2>
          <span className="text-xs text-zinc-500">
            now {fmtCurrency(cf.currentCash)} · projected {fmtCurrency(cf.projectedMonthEndBalance)}
          </span>
        </header>
        <CashflowChart days={cf.days} today={cf.today} monthLabel={cf.monthLabel} />
        <p className="mt-3 text-xs text-zinc-400">
          Projection = everyday spending (~{fmtCurrency(cf.baselineDailyNet)}/day, excluding recurring) plus your known
          recurring bills &amp; income on their due dates. Projected month net {fmtCurrency(cf.projectedMonthNet)}.
        </p>
      </section>

      {cf.recurringInMonth.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
              Recurring factored into the rest of {cf.monthLabel.split(' ')[0]}
            </h2>
          </header>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {cf.recurringInMonth.map((r, i) => (
              <li key={`${r.date}-${r.label}-${i}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-20 shrink-0 tabular-nums text-zinc-500">{r.date.slice(5)}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{r.label}</span>
                <span className={`tabular-nums ${r.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {r.type === 'income' ? '+' : '−'}{fmtCurrency(r.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
