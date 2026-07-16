import { requireSession } from '@/lib/auth/session';
import { getPersonalAccounts, getRecentTransactions, getTransactionCount } from '@/lib/personal/queries';
import { getPersonalCategories } from '@/lib/personal/categories';
import { fmtSignedAmount } from '@/lib/personal/format';
import { CategoryCell } from './_components/CategoryCell';

export const dynamic = 'force-dynamic';

export default async function PersonalTransactionsPage() {
  const user = await requireSession();
  const [accounts, txns, total, categories] = await Promise.all([
    getPersonalAccounts(user.id),
    getRecentTransactions(user.id, 200),
    getTransactionCount(user.id),
    getPersonalCategories(user.id),
  ]);

  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const categoryOptions = categories.map((c) => ({ name: c.name, groupName: c.groupName }));

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Transactions</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {total.toLocaleString()} total · showing latest {Math.min(txns.length, 200)}
        </p>
      </header>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {txns.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                  No transactions yet. Connect an account to start syncing.
                </td>
              </tr>
            )}
            {txns.map((t) => (
              <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 tabular-nums text-zinc-500">{t.date}</td>
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{t.merchant ?? t.description ?? '—'}</td>
                <td className="px-4 py-2">
                  <CategoryCell txnId={t.id} merchant={t.merchant} current={t.category} categories={categoryOptions} />
                </td>
                <td className="px-4 py-2 text-zinc-500">{accountName.get(t.accountId) ?? '—'}</td>
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
