'use client';

import { useTransition } from 'react';
import { dismissPlaidReview } from '../_actions/dismissReview';

export function ReviewBanner({ reviewableCount }: { reviewableCount: number }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <div className="space-y-1">
        <div className="font-medium">Review your linked accounts</div>
        <p className="text-xs leading-relaxed">
          {reviewableCount === 1 ? '1 mapped account is' : `${reviewableCount} mapped accounts are`} not yet
          marked as part of this business&apos;s books. Linking a bank can surface personal accounts at the
          same institution — those should stay excluded. Click <strong>Add to books</strong> on the rows
          for accounts that belong to this business.
        </p>
      </div>
      <button
        type="button"
        onClick={() => startTransition(async () => { await dismissPlaidReview(); })}
        disabled={pending}
        className="shrink-0 rounded-md border border-amber-400 px-2 py-1 text-xs hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900/40"
      >
        {pending ? '…' : 'Dismiss'}
      </button>
    </div>
  );
}
