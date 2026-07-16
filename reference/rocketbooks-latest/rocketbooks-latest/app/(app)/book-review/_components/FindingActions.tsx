'use client';

import { useState, useTransition } from 'react';
import { resolveDuplicateFinding, dismissBookFinding } from '../_actions/resolve';

interface TxnOption {
  id: string;
  label: string;
}

interface Props {
  findingId: string;
  kind: 'duplicate' | 'integrity';
  /** The duplicate pair — each becomes a "this one's the duplicate" button. */
  options?: TxnOption[];
}

export function FindingActions({ findingId, kind, options = [] }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const reverse = (txnId: string) => {
    setError(null);
    startTransition(async () => {
      const r = await resolveDuplicateFinding({ findingId, duplicateTransactionId: txnId });
      if (!r.ok) setError(r.error ?? 'Failed');
    });
  };

  const dismiss = () => {
    setError(null);
    startTransition(async () => {
      const r = await dismissBookFinding({ findingId });
      if (!r.ok) setError(r.error ?? 'Failed');
    });
  };

  const primaryCls =
    'inline-flex items-center rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50';
  const mutedCls =
    'inline-flex items-center rounded-md border border-zinc-300 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {kind === 'duplicate' &&
          options.map((o) => (
            <button key={o.id} type="button" disabled={pending} onClick={() => reverse(o.id)} className={primaryCls}>
              {pending ? 'Working…' : `Reverse ${o.label}`}
            </button>
          ))}
        <button type="button" disabled={pending} onClick={dismiss} className={mutedCls}>
          {kind === 'duplicate' ? 'Keep both' : 'Dismiss'}
        </button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
