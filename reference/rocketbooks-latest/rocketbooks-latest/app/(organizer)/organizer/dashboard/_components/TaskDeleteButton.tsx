'use client';

import { useActionState } from 'react';
import { deleteTaskAction, type DeleteTaskState } from '../_actions/tasks';

interface Props {
  taskId: string;
  title: string;
}

/**
 * Inline trash button on each task row. Browser-confirm before
 * submitting the server action — deletion is irreversible and there's
 * no undo flow yet, so the cheap modal is worth it.
 */
export function TaskDeleteButton({ taskId, title }: Props) {
  const [state, formAction, pending] = useActionState<DeleteTaskState | undefined, FormData>(
    deleteTaskAction,
    undefined,
  );

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Delete this task?\n\n"${title}"`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={taskId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Delete task: ${title}`}
        title={state?.error ?? 'Delete this task'}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </form>
  );
}
