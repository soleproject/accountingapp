'use client';

import { useEffect, useState } from 'react';
import type { TransactionLandingRow } from '../_lib/loadTransactionsLanding';

export function TransactionsLandingClient({ initialRows = null }: { initialRows?: TransactionLandingRow[] | null }) {
  const [fallbackRows, setFallbackRows] = useState<TransactionLandingRow[] | null>(null);
  const [error, setError] = useState(false);
  const rows = initialRows ?? fallbackRows;

  useEffect(() => {
    if (initialRows !== null) return;
    let cancelled = false;
    fetch('/api/transactions/landing', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: { rows?: TransactionLandingRow[] }) => {
        if (!cancelled) setFallbackRows(Array.isArray(data.rows) ? data.rows : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRows]);

  if (initialRows === null && error) {
    return <p className="text-sm text-amber-600">Recent transactions are still loading. Use filters or refresh if needed.</p>;
  }

  if (!rows) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) return <p className="text-sm text-zinc-500">No recent transactions found.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
        <tr>
          <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Date</th>
          <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Description</th>
          <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Contact</th>
          <th className="px-4 py-2 font-medium text-zinc-600 dark:text-zinc-400">Category</th>
          <th className="px-4 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
            <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{row.date ?? '—'}</td>
            <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{row.bankDescription ?? row.description ?? '—'}</td>
            <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{row.contactName ?? '—'}</td>
            <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{row.categoryAccountName ?? <span className="text-amber-600">Uncategorized</span>}</td>
            <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
              {row.amount != null ? (
                <span className={row.type === 'deposit' ? 'font-medium text-emerald-600 dark:text-emerald-400' : undefined}>
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(row.amount)}
                </span>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
