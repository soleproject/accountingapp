'use client';

import { useState, useTransition } from 'react';
import { useCardFlip } from './CardFlipContext';
import { getTaskPlan } from '../_actions/taskPlan';

/**
 * The task title in the Open Tasks card. Clicking it resolves the task's step
 * plan (persisted, or AI-decomposed on first open) and flips the dashboard:
 * the left column shows the step checklist, the right card runs the active
 * step. Replaces the old "go straight to the full workspace" link — the full
 * workspace is still reachable from the checklist's "Open full workspace ↗".
 *
 * AI only runs on first click of a task without a saved plan; subsequent clicks
 * read the stored plan and flip instantly, so the dashboard itself stays fast.
 */
export function TaskRowTitle({ taskId, title }: { taskId: string; title: string }) {
  const { open } = useCardFlip();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    start(async () => {
      const plan = await getTaskPlan(taskId);
      if (!plan.ok) {
        setError(plan.error ?? 'Could not open this task.');
        return;
      }
      open({ kind: 'task-plan', plan });
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="flex-1 truncate text-left text-zinc-800 hover:text-indigo-600 hover:underline disabled:opacity-60 dark:text-zinc-200 dark:hover:text-indigo-400"
      title={error ?? 'Open step plan'}
    >
      {pending ? `${title} …` : title}
      {error && <span className="ml-2 text-[10px] text-rose-500">{error}</span>}
    </button>
  );
}
