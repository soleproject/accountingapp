'use client';

import { useActionState } from 'react';
import { approveTransaction, type ApproveState } from '../_actions/approveTransaction';

/**
 * One-click "Approve" button for a row in the to_review queue. Sets
 * reviewed=true without changing the category. Used when the auto-
 * classification is correct as-is and the user just needs to clear it
 * out of the queue.
 */
export function ApproveButton({ transactionId }: { transactionId: string }) {
  const [state, formAction, pending] = useActionState<ApproveState | undefined, FormData>(
    approveTransaction,
    undefined,
  );

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="transactionId" value={transactionId} />
      <button
        type="submit"
        disabled={pending || state?.ok}
        className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
      >
        {pending ? '…' : state?.ok ? '✓' : 'Approve'}
      </button>
      {state?.error && <span className="text-xs text-rose-600 dark:text-rose-400">{state.error}</span>}
    </form>
  );
}
