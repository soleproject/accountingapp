'use client';

import { useState, useTransition } from 'react';
import { promoteImportAction, type PromoteState } from '../_actions/promote';

interface Props {
  importId: string;
  pendingCount: number;
}

export function PromoteButton({ importId, pendingCount }: Props) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<PromoteState | undefined>();

  const onClick = () => {
    if (pendingCount === 0) return;
    startTransition(async () => {
      const result = await promoteImportAction(importId, state);
      setState(result);
    });
  };

  const message = (() => {
    if (pending) return 'Promoting…';
    if (state?.error) return `✗ ${state.error}`;
    if (state?.ok) {
      const parts: string[] = [];
      if (typeof state.promoted === 'number') parts.push(`promoted ${state.promoted}`);
      if (typeof state.skipped === 'number' && state.skipped > 0) parts.push(`skipped ${state.skipped}`);
      if (state.reason && state.promoted === 0) parts.push(state.reason);
      return `✓ ${parts.join(' · ')}`;
    }
    return null;
  })();

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || pendingCount === 0}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        title={pendingCount === 0 ? 'Nothing left to promote' : `Promote ${pendingCount} into transactions`}
      >
        {pending ? 'Promoting…' : `Promote ${pendingCount} → Transactions`}
      </button>
      {message && (
        <span className={`text-sm ${state?.error ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
          {message}
        </span>
      )}
    </div>
  );
}
