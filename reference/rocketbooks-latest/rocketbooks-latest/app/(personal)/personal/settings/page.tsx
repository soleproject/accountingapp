import { requireSession } from '@/lib/auth/session';
import { getPersonalAccounts } from '@/lib/personal/queries';

export const dynamic = 'force-dynamic';

export default async function PersonalSettingsPage() {
  const user = await requireSession();
  const accounts = await getPersonalAccounts(user.id);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Personal finance preferences</p>
      </header>

      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Linked accounts</h2>
        </header>
        <table className="w-full text-sm">
          <tbody>
            {accounts.length === 0 && (
              <tr><td className="px-4 py-6 text-center text-zinc-500">No accounts linked.</td></tr>
            )}
            {accounts.map((a) => (
              <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{a.name}</td>
                <td className="px-4 py-2 text-zinc-500">{a.institution ?? '—'}</td>
                <td className="px-4 py-2 text-right text-xs text-zinc-400">{a.plaidAccountId ? 'Plaid-linked' : 'Manual'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
        Category management, pay schedule, manual asset entry, and shared-household access arrive in later phases.
      </div>
    </div>
  );
}
