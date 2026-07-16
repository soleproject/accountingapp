'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { PinnedRuleCard as PinnedRule } from './AssistantContext';

interface AcceptRuleState { ok?: boolean; verified?: number; error?: string }

/** The rule-suggestion card pinned at the bottom of the sidecar. */
export function RulePinnedCard({ rule, onDone }: { rule: PinnedRule; onDone: () => void }) {
  const [state, setState] = useState<AcceptRuleState>();
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      const response = await fetch('/api/transactions/accept-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: rule.pattern, categoryAccountId: rule.categoryAccountId, transactionType: rule.transactionType ?? null }),
      });
      const result = await response.json() as AcceptRuleState;
      if (!response.ok && !result.error) result.error = 'Could not create that rule.';
      setState(result);
      if (result.ok) {
        onDone();
        if (rule.returnTo) router.push(rule.returnTo);
        router.refresh();
      }
    } catch {
      setState({ error: 'Could not create that rule.' });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Create a rule for &ldquo;{rule.pattern}&rdquo;?</div>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          Categorized as <strong className="text-zinc-800 dark:text-zinc-200">{rule.categoryName}</strong> {rule.count}×.
          Create a rule so future ones auto-categorize, and mark all matching transactions reviewed.
        </p>
        {state?.error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onDone} className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">Not now</button>
          <form onSubmit={submit}>
            <button type="submit" disabled={pending} className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {pending ? 'Working…' : 'Create rule & verify all'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
