import { requireSession } from '@/lib/auth/session';
import { getPersonalAccounts, computeNetWorth, isLiability } from '@/lib/personal/queries';
import { fmtCurrency } from '@/lib/personal/format';
import { ConnectPersonalBankButton } from './_components/ConnectPersonalBankButton';

export const dynamic = 'force-dynamic';

export default async function PersonalAccountsPage() {
  const user = await requireSession();
  const accounts = await getPersonalAccounts(user.id);
  const nw = computeNetWorth(accounts);

  const assets = accounts.filter((a) => !isLiability(a.type));
  const liabilities = accounts.filter((a) => isLiability(a.type));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Banks, cards, loans, and assets</p>
        </div>
        <ConnectPersonalBankButton />
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Assets</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCurrency(nw.assets)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Liabilities</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">{fmtCurrency(nw.liabilities)}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Net worth</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtCurrency(nw.net)}</div>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <h2 className="text-lg font-medium">No accounts linked yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
            Connect a checking, savings, credit card, or loan account via Plaid to start tracking automatically.
          </p>
          <div className="mt-4 flex justify-center">
            <ConnectPersonalBankButton />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <AccountGroup title="Assets" rows={assets} empty="No asset accounts." />
          <AccountGroup title="Liabilities" rows={liabilities} empty="No debts — nice." />
        </div>
      )}
    </div>
  );
}

function AccountGroup({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof getPersonalAccounts>>;
  empty: string;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{title}</h2>
      </header>
      <table className="w-full text-sm">
        <tbody>
          {rows.length === 0 && (
            <tr><td className="px-4 py-6 text-center text-zinc-500">{empty}</td></tr>
          )}
          {rows.map((a) => (
            <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-4 py-2">
                <div className="font-medium text-zinc-700 dark:text-zinc-300">{a.name}</div>
                <div className="text-xs text-zinc-500">{a.institution ?? '—'} · {a.type}</div>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(a.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
