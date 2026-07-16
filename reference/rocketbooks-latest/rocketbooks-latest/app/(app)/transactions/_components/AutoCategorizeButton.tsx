'use client';

import { useActionState } from 'react';
import { triggerAutoCategorize, type TriggerAutoCategorizeState } from '../_actions/triggerAutoCategorize';

export function AutoCategorizeButton({ uncategorizedCount }: { uncategorizedCount: number }) {
  const [state, action, pending] = useActionState<TriggerAutoCategorizeState | undefined, FormData>(
    async () => triggerAutoCategorize(undefined),
    undefined,
  );

  if (uncategorizedCount === 0 && !state?.queued) {
    return (
      <span className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700">
        Nothing to auto-categorize
      </span>
    );
  }

  return (
    <form action={action} className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {pending
          ? 'Queueing…'
          : `✨ Auto-categorize ${uncategorizedCount.toLocaleString()} uncategorized`}
      </button>
      {state?.error && <span className="text-xs text-red-600">{state.error}</span>}
      {state?.queued != null && state.queued > 0 && (
        <span className="text-xs text-emerald-700 dark:text-emerald-300">
          ✓ Queued {state.queued}
          {state.remaining ? ` (${state.remaining} more — click again)` : ''}. Inngest is processing — refresh in a minute.
        </span>
      )}
      {state?.queued === 0 && state?.remaining === 0 && (
        <span className="text-xs text-zinc-500">Nothing left.</span>
      )}
    </form>
  );
}
