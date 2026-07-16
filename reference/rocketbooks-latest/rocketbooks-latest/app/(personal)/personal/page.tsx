import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import {
  getPersonalAccounts,
  computeNetWorth,
  getRecentTransactions,
  getMonthCashflow,
  getSpendByCategory,
  getGoals,
  currentMonthStartISO,
  isLiability,
} from '@/lib/personal/queries';
import { fmtCurrency, fmtSignedAmount } from '@/lib/personal/format';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

export default async function PersonalOverviewPage() {
  const user = await requireSession();
  const monthStart = currentMonthStartISO(new Date());

  const [accounts, recent, cashflow, topCats, goals] = await Promise.all([
    getPersonalAccounts(user.id),
    getRecentTransactions(user.id, 8),
    getMonthCashflow(user.id, monthStart),
    getSpendByCategory(user.id, monthStart),
    getGoals(user.id),
  ]);

  const nw = computeNetWorth(accounts);
  const hasData = accounts.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Your money at a glance</p>
        </div>
        <Link
          href="/personal/accounts"
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {hasData ? 'Manage accounts' : 'Connect an account'}
        </Link>
      </header>

      {!hasData && (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">Link your first account</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Connect a bank, card, or loan to automatically track your net worth, spending, and cash flow.
          </p>
          <Link
            href="/personal/accounts"
            className="mt-4 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Connect an account
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Net worth" value={fmtCurrency(nw.net)} sub={`${fmtCurrency(nw.assets)} assets · ${fmtCurrency(nw.liabilities)} debt`} />
        <StatCard label="Income this month" value={fmtCurrency(cashflow.income)} />
        <StatCard label="Spending this month" value={fmtCurrency(cashflow.spending)} />
        <StatCard
          label="Net this month"
          value={fmtCurrency(cashflow.net)}
          sub={cashflow.net >= 0 ? 'Saving' : 'Spending more than you earn'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Accounts */}
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Accounts</h2>
            <Link href="/personal/accounts" className="text-xs text-zinc-500 hover:underline">View all</Link>
          </header>
          <table className="w-full text-sm">
            <tbody>
              {accounts.length === 0 && (
                <tr><td className="px-4 py-6 text-center text-zinc-500">No accounts yet.</td></tr>
              )}
              {accounts.slice(0, 6).map((a) => (
                <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2">
                    <div className="font-medium text-zinc-700 dark:text-zinc-300">{a.name}</div>
                    <div className="text-xs text-zinc-500">{a.institution ?? a.type}</div>
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums ${isLiability(a.type) ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-700 dark:text-zinc-300'}`}>
                    {fmtCurrency(a.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Top spending categories this month */}
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Top categories this month</h2>
            <Link href="/personal/reports" className="text-xs text-zinc-500 hover:underline">Reports</Link>
          </header>
          <table className="w-full text-sm">
            <tbody>
              {topCats.length === 0 && (
                <tr><td className="px-4 py-6 text-center text-zinc-500">No spending recorded this month.</td></tr>
              )}
              {topCats.slice(0, 6).map((c) => (
                <tr key={c.category} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{c.category}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(c.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Goals */}
      {goals.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Goals</h2>
            <Link href="/personal/goals" className="text-xs text-zinc-500 hover:underline">View all</Link>
          </header>
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {goals.slice(0, 3).map((g) => {
              const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100)) : 0;
              return (
                <div key={g.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{g.name}</span>
                    <span className="text-xs text-zinc-500">{pct}%</span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {fmtCurrency(g.currentAmount)} of {fmtCurrency(g.targetAmount)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent transactions */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Recent transactions</h2>
          <Link href="/personal/transactions" className="text-xs text-zinc-500 hover:underline">View all</Link>
        </header>
        <table className="w-full text-sm">
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-zinc-500">No transactions yet.</td></tr>
            )}
            {recent.map((t) => (
              <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-500">{t.date}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                  {t.merchant ?? t.description ?? '—'}
                  {t.category && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{t.category}</span>}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${t.amount > 0 ? 'text-zinc-700 dark:text-zinc-300' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {fmtSignedAmount(t.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
