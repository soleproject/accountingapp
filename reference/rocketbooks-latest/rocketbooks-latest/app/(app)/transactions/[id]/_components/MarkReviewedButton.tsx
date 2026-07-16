'use client';

import { useActionState } from 'react';
import { setTransactionReviewed, type ReviewedState } from '../../_actions/approveTransaction';

/**
 * Edit-screen reviewed toggle. Outline "Mark as reviewed" when unreviewed,
 * solid green "✓ Reviewed" when reviewed (click to unmark). Reflects the action
 * result so it flips instantly without a full page reload.
 */
export function MarkReviewedButton({
  transactionId,
  reviewed,
}: {
  transactionId: string;
  reviewed: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReviewedState | undefined, FormData>(
    setTransactionReviewed,
    undefined,
  );
  const isReviewed = state?.ok && typeof state.reviewed === 'boolean' ? state.reviewed : reviewed;

  return (
    <form action={formAction}>
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="reviewed" value={isReviewed ? '0' : '1'} />
      <button
        type="submit"
        disabled={pending}
        aria-pressed={isReviewed}
        className={`inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
          isReviewed
            ? 'bg-emerald-500 text-white hover:bg-emerald-600'
            : 'border border-blue-300 text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950/40'
        }`}
      >
        {isReviewed ? '✓ Reviewed' : 'Mark as reviewed'}
      </button>
    </form>
  );
}
