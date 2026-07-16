'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Time-frame selector for the enterprise dashboard. Writes the selection to the
 * URL (?period=this_month | last_month, or ?from=&to= for custom) so the server
 * component re-fetches scoped data. Date-based signals (to-review, recon,
 * bills/invoices due, tasks due, meeting debriefs, AI handled) scope to the
 * window; current-state signals (bank, onboarding) always reflect today.
 */
export function PeriodFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const selected = sp.get('period') ?? (sp.get('from') || sp.get('to') ? 'custom' : 'all');
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function onPreset(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    if (v === 'custom') apply({ period: 'custom', from: from || null, to: to || null });
    else apply({ period: v === 'all' ? null : v, from: null, to: null });
  }

  const fieldCls =
    'rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={selected} onChange={onPreset} className={fieldCls} aria-label="Time frame">
        <option value="all">All open</option>
        <option value="this_month">This month</option>
        <option value="last_month">Last month</option>
        <option value="custom">Custom…</option>
      </select>
      {selected === 'custom' && (
        <span className="flex items-center gap-1">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={fieldCls}
            aria-label="From date"
          />
          <span className="text-zinc-400">–</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={fieldCls}
            aria-label="To date"
          />
          <button
            type="button"
            onClick={() => apply({ period: 'custom', from: from || null, to: to || null })}
            disabled={!from || !to}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Apply
          </button>
        </span>
      )}
    </div>
  );
}
