import Link from 'next/link';
import { and, or, eq, ne, desc, count, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { reconciliationPeriods, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createManualReconciliationAction } from './_actions';
import { EditReconciliationButton } from './_components/EditReconciliationButton';

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export default async function ReconciliationPage() {
  const orgId = await getCurrentOrgId();

  const [[total], periods, accounts] = await Promise.all([
    db.select({ n: count() }).from(reconciliationPeriods).where(eq(reconciliationPeriods.organizationId, orgId)),
    db
      .select({
        id: reconciliationPeriods.id,
        startDate: reconciliationPeriods.startDate,
        endDate: reconciliationPeriods.endDate,
        status: reconciliationPeriods.status,
        isManual: reconciliationPeriods.isManual,
        statementOpening: reconciliationPeriods.statementOpeningBalance,
        statementClosing: reconciliationPeriods.statementClosingBalance,
        ledgerClosing: reconciliationPeriods.ledgerClosingBalance,
        difference: reconciliationPeriods.difference,
        accountName: chartOfAccounts.accountName,
      })
      .from(reconciliationPeriods)
      .leftJoin(chartOfAccounts, eq(reconciliationPeriods.accountId, chartOfAccounts.id))
      .where(eq(reconciliationPeriods.organizationId, orgId))
      .orderBy(desc(reconciliationPeriods.endDate))
      .limit(50),
    db
      .select({ id: chartOfAccounts.id, accountName: chartOfAccounts.accountName })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.organizationId, orgId),
          ne(chartOfAccounts.isActive, false),
          or(
            inArray(chartOfAccounts.accountType, ['bank', 'credit_card']),
            inArray(chartOfAccounts.detailType, ['cash_bank', 'checking', 'savings', 'credit_card', 'money_market']),
          ),
        ),
      )
      .orderBy(chartOfAccounts.accountName),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Reconciliation</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{(total?.n ?? 0).toLocaleString()} reconciliation period(s)</p>
        </div>
      </header>

      {/* Start a reconciliation by hand */}
      <details className="group rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
          <span>New reconciliation</span>
          <span className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white group-open:hidden">+ Start</span>
        </summary>
        {accounts.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-zinc-500">No bank or credit-card accounts found for this workspace.</p>
        ) : (
          <form action={createManualReconciliationAction} className="grid grid-cols-1 gap-3 border-t border-zinc-100 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3 dark:border-zinc-800">
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400 sm:col-span-2 lg:col-span-1">
              Account
              <select name="accountId" required defaultValue="" className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                <option value="" disabled>Select an account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Statement start date
              <input type="date" name="fromDate" required className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Statement end date
              <input type="date" name="toDate" required className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Beginning balance
              <input type="number" step="0.01" name="beginningBalance" placeholder="Auto (prior period's ending)" className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
              <span className="text-[11px] text-zinc-400">Leave blank to carry the last reconciliation&rsquo;s ending balance.</span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Ending balance
              <input type="number" step="0.01" name="endingBalance" required placeholder="From the statement" className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950" />
            </label>
            <div className="flex items-end">
              <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Start reconciliation</button>
            </div>
          </form>
        )}
      </details>

      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Period</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Account</th>
              <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Statement</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Ledger</th>
              <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Diff</th>
              <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500"></th>
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-500">No reconciliation periods yet.</td></tr>
            )}
            {periods.map((p) => {
              const diff = p.difference != null ? Number(p.difference) : null;
              return (
                <tr key={p.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2 tabular-nums">
                    <Link href={`/reconciliation/${p.id}`} className="text-blue-600 hover:underline dark:text-blue-400">{p.startDate} → {p.endDate}</Link>
                    {p.isManual && <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800">manual</span>}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{p.accountName ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${p.status === 'RECONCILED' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800'}`}>{p.status}</span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{p.statementClosing != null ? fmt(Number(p.statementClosing)) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{p.ledgerClosing != null ? fmt(Number(p.ledgerClosing)) : '—'}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${diff != null && Math.abs(diff) > 0.01 ? 'text-red-600' : 'text-zinc-700 dark:text-zinc-300'}`}>{diff != null ? fmt(diff) : '—'}</td>
                  <td className="px-2 py-2 text-right">
                    <EditReconciliationButton
                      period={{
                        id: p.id,
                        startDate: p.startDate,
                        endDate: p.endDate,
                        statementOpening: p.statementOpening != null ? String(p.statementOpening) : null,
                        statementClosing: p.statementClosing != null ? String(p.statementClosing) : null,
                        accountName: p.accountName,
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
