'use client';

import { useState, useTransition } from 'react';
import { setSubstantiation } from '../_actions/substantiation';

/**
 * Org-level opt-in for automatic weekly IRS-documentation requests. Requires
 * inbound email so the client's reply can be filed; shows a notice when it isn't.
 */
export function SubstantiationCard({ enabled, inboundReady }: { enabled: boolean; inboundReady: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const r = await setSubstantiation(next);
      if (!r.ok) {
        setError(r.error ?? 'Save failed');
        setOn(!next);
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">IRS Documentation Requests</h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          When on, the client gets a weekly email asking for the IRS-required documentation on recent transactions that
          need it (business meals, travel, gifts, vehicle, charitable). Their reply is parsed and filed against each
          transaction automatically. See the IRS Documentation page under Accounting.
        </p>

        {!inboundReady && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Inbound email isn’t configured, so replies can’t be received yet — this stays inactive until that’s set up.
          </div>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Status</span>
          <select
            value={on ? 'on' : 'off'}
            onChange={(e) => {
              const next = e.target.value === 'on';
              setOn(next);
              save(next);
            }}
            disabled={isPending}
            className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{error}</div>
        )}
        {isPending && <div className="text-xs text-zinc-500">Saving…</div>}
      </div>
    </section>
  );
}
