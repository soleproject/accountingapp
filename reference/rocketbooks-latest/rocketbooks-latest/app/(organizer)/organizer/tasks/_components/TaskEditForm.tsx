'use client';

import { useActionState, useEffect } from 'react';
import { updateTaskAction, type UpdateTaskState } from '../_actions/updateTask';
import { LinkedItemsManager } from './LinkedItemsManager';

interface Props {
  taskId: string;
  initialTitle: string;
  initialDescription: string | null;
  initialDueDate: string | null;
  initialPriority: string | null;
  onClose: () => void;
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // <input type="date"> wants YYYY-MM-DD in the browser's local view of
  // the value. Using UTC parts is consistent with how we store
  // (midnight UTC); a local-tz quirk just shifts the displayed day by
  // one — acceptable for v1, fix when we add per-user timezones.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function TaskEditForm({
  taskId,
  initialTitle,
  initialDescription,
  initialDueDate,
  initialPriority,
  onClose,
}: Props) {
  const [state, formAction, pending] = useActionState<UpdateTaskState | undefined, FormData>(
    updateTaskAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  return (
    <div className="flex flex-col gap-3">
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <input type="hidden" name="id" value={taskId} />
      <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        Title
        <input
          name="title"
          defaultValue={initialTitle}
          required
          maxLength={200}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
        Description
        <textarea
          name="description"
          rows={3}
          maxLength={5000}
          defaultValue={initialDescription ?? ''}
          className="resize-none rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          Due date
          <input
            name="dueDate"
            type="date"
            defaultValue={isoToDateInput(initialDueDate)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          Priority
          <select
            name="priority"
            defaultValue={initialPriority ?? ''}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">— none —</option>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
          </select>
        </label>
      </div>

      {state?.error && <p className="text-xs text-rose-600 dark:text-rose-400">{state.error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
      <LinkedItemsManager taskId={taskId} />
    </div>
  );
}
