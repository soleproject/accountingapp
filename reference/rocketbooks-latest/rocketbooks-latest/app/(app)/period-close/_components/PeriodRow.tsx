'use client';

import { useState, useTransition } from 'react';
import { transitionPeriod, type PeriodStatus } from '../_actions/transitionPeriod';

const BTN =
  'inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BTN} border-zinc-300 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800`;
const DANGER = `${BTN} border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200`;
const MUTED = `${BTN} border-zinc-200 bg-transparent text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800`;

export function PeriodRow({
  year,
  month,
  status,
  canManage,
}: {
  year: number;
  month: number;
  status: PeriodStatus;
  canManage: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const go = (to: PeriodStatus) => {
    setError(null);
    startTransition(async () => {
      const r = await transitionPeriod(year, month, to);
      if (!r.ok) setError(r.error ?? 'Failed');
    });
  };

  if (!canManage) return <span className="text-xs text-zinc-400">Owner only</span>;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === 'open' && (
          <>
            <button type="button" disabled={pending} onClick={() => go('reviewed')} className={PRIMARY}>Mark reviewed</button>
            <button type="button" disabled={pending} onClick={() => go('closed')} className={DANGER}>Close</button>
          </>
        )}
        {status === 'reviewed' && (
          <>
            <button type="button" disabled={pending} onClick={() => go('closed')} className={DANGER}>Close</button>
            <button type="button" disabled={pending} onClick={() => go('open')} className={MUTED}>Reopen</button>
          </>
        )}
        {status === 'closed' && (
          <button type="button" disabled={pending} onClick={() => go('open')} className={MUTED}>Reopen</button>
        )}
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
