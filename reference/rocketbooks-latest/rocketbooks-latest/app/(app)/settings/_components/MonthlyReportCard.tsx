'use client';

import { useState, useTransition } from 'react';
import { setMonthlyReport } from '../_actions/monthlyReport';

/**
 * Org-level monthly financial-statement report email. Toggle + optional extra
 * recipients (the org owner always gets it). Optimistic with rollback, matching
 * MeetingFollowupsCard.
 */
export function MonthlyReportCard({ enabled, recipients }: { enabled: boolean; recipients: string }) {
  const [on, setOn] = useState(enabled);
  const [recip, setRecip] = useState(recipients);
  const [savedRecip, setSavedRecip] = useState(recipients);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: { enabled?: boolean; recipients?: string }) => {
    setError(null);
    startTransition(async () => {
      const r = await setMonthlyReport(next);
      if (!r.ok) {
        setError(r.error ?? 'Save failed');
        if (next.enabled !== undefined) setOn(!next.enabled);
        if (next.recipients !== undefined) setRecip(savedRecip);
        return;
      }
      if (next.recipients !== undefined) setSavedRecip(next.recipients);
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Monthly Report Email</h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          On the 1st of each month, email the client a snapshot of last month&apos;s P&amp;L and balance sheet with a
          link to the full statements. The org owner always receives it; add any extra recipients below.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Status</span>
          <select
            value={on ? 'on' : 'off'}
            onChange={(e) => {
              const next = e.target.value === 'on';
              setOn(next);
              save({ enabled: next });
            }}
            disabled={isPending}
            className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Extra recipients</span>
          <span className="text-xs text-zinc-500">Comma- or line-separated emails (optional).</span>
          <textarea
            value={recip}
            onChange={(e) => setRecip(e.target.value)}
            onBlur={() => { if (recip !== savedRecip) save({ recipients: recip }); }}
            rows={2}
            placeholder="cfo@client.com, owner@client.com"
            disabled={isPending || !on}
            className="max-w-md rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        {isPending && <div className="text-xs text-zinc-500">Saving…</div>}
      </div>
    </section>
  );
}
