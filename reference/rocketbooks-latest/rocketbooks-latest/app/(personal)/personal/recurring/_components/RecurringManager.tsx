'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { fmtCurrency } from '@/lib/personal/format';
import { rescanRecurringAction, setRecurringStatusAction } from '../_actions/recurring';

interface Row {
  id: string;
  displayMerchant: string;
  type: string;
  cadence: string;
  avgAmount: number;
  lastAmount: number;
  lastDate: string;
  nextDate: string;
  occurrences: number;
  category: string | null;
  monthlyCost: number;
}

function daysUntil(iso: string, todayISO: string): number {
  const d = (new Date(iso + 'T00:00:00Z').getTime() - new Date(todayISO + 'T00:00:00Z').getTime()) / 86400000;
  return Math.round(d);
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly',
};

export function RecurringManager({ rows, todayISO }: { rows: Row[]; todayISO: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const rescan = () => startTransition(async () => {
    const r = await rescanRecurringAction();
    setMsg(r.ok ? `Scan complete — ${r.found} recurring series detected.` : (r.error ?? 'Scan failed'));
    router.refresh();
  });

  const hide = (id: string) => startTransition(async () => {
    await setRecurringStatusAction({ id, status: 'hidden' });
    router.refresh();
  });

  const upcoming = rows
    .filter((r) => r.type === 'expense')
    .map((r) => ({ ...r, days: daysUntil(r.nextDate, todayISO) }))
    .filter((r) => r.days >= 0 && r.days <= 30)
    .sort((a, b) => a.days - b.days);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={rescan}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? 'Scanning…' : 'Rescan transactions'}
        </button>
        {msg && <span className="text-xs text-zinc-500">{msg}</span>}
      </div>

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Upcoming (next 30 days)</h2>
          </header>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {upcoming.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <div className="flex h-9 w-12 flex-col items-center justify-center rounded bg-zinc-100 text-center dark:bg-zinc-800">
                  <span className="text-[10px] uppercase text-zinc-500">{new Date(r.nextDate + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span>
                  <span className="text-sm font-semibold leading-none">{new Date(r.nextDate + 'T00:00:00Z').getUTCDate()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-zinc-700 dark:text-zinc-300">{r.displayMerchant}</div>
                  <div className="text-xs text-zinc-500">{r.days === 0 ? 'due today' : `in ${r.days} day${r.days === 1 ? '' : 's'}`} · {r.category ?? '—'}</div>
                </div>
                <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(r.avgAmount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* All recurring */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">All recurring</h2>
        </header>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-4 py-2 font-medium">Merchant</th>
              <th className="px-4 py-2 font-medium">Frequency</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 text-right font-medium">Per month</th>
              <th className="px-4 py-2 font-medium">Next</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-zinc-500">No recurring charges detected yet. Click “Rescan transactions”.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-2">
                  <div className="font-medium text-zinc-700 dark:text-zinc-300">{r.displayMerchant}</div>
                  <div className="text-xs text-zinc-500">{r.category ?? '—'}{r.type === 'income' ? ' · income' : ''}</div>
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{CADENCE_LABEL[r.cadence] ?? r.cadence}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmtCurrency(r.avgAmount)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-500">{fmtCurrency(r.monthlyCost)}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-500">{r.nextDate}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => hide(r.id)}
                    disabled={pending}
                    className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-900"
                    title="Hide — not a real subscription"
                  >
                    Hide
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
