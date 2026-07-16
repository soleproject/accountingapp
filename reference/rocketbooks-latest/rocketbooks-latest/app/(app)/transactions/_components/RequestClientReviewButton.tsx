'use client';

import { useActionState } from 'react';
import { requestClientReview } from '../_actions/requestClientReview';
import type { ReviewRequestResult } from '@/lib/accounting/review-outreach';

/**
 * Accountant-only action: email/text the client a nudge to answer the AI's
 * questions about their pending review transactions. Shown on the to_review
 * queue. Result feedback inline; cooldown-guarded server-side.
 */
export function RequestClientReviewButton({ count }: { count: number }) {
  const [state, action, pending] = useActionState<ReviewRequestResult | undefined, FormData>(
    requestClientReview,
    undefined,
  );

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30"
        title="Email (and text, if opted in) the client a link to answer the AI's questions about these transactions"
      >
        ✉️ Request client input{count > 0 ? ` (${count})` : ''}
      </button>
      {state?.ok && !state.skipped && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          Sent{state.channels?.length ? ` via ${state.channels.join(' + ')}` : ''}
        </span>
      )}
      {state?.skipped && (
        <span className="text-xs text-zinc-500">{state.error ?? 'Nothing to send right now'}</span>
      )}
      {state && !state.ok && (
        <span className="text-xs text-rose-600 dark:text-rose-400">{state.error}</span>
      )}
    </form>
  );
}
