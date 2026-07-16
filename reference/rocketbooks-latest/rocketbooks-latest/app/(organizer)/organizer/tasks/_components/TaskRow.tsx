'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TaskAiButton } from '@/app/(organizer)/organizer/dashboard/_components/TaskAiButton';
import { TaskDeleteButton } from '@/app/(organizer)/organizer/dashboard/_components/TaskDeleteButton';
import { TaskEditForm } from './TaskEditForm';

interface Task {
  id: string;
  title: string;
  description: string | null;
  module: string | null;
  priority: string | null;
  status: string;
  dueDate: string | null;
  page?: string | null;
}

interface Props {
  task: Task;
}

function fmtDue(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

/**
 * One task row. Renders the data cells plus a small action toolbar
 * (AI sparkle / edit pencil / trash). The pencil toggles a local
 * `editing` state; when on, the form renders inside a second <tr>
 * that spans the full table width. Submit closes itself via the
 * onClose prop, server action revalidates.
 */
export function TaskRow({ task }: Props) {
  const [editing, setEditing] = useState(false);

  const href = `/organizer/tasks/${task.id}/workspace`;

  const statusTone =
    task.status === 'DONE'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';

  return (
    <>
      <tr className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
        <td className="px-4 py-2">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusTone}`}
          >
            {task.status}
          </span>
        </td>
        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
          <Link
            href={href}
            className="font-medium hover:text-indigo-600 hover:underline dark:hover:text-indigo-400"
          >
            {task.title}
          </Link>
          {task.description && (
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{task.description}</div>
          )}
        </td>
        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{task.module ?? '—'}</td>
        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{task.priority ?? '—'}</td>
        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{fmtDue(task.dueDate)}</td>
        <td className="px-4 py-2">
          <div className="flex items-center justify-end gap-1">
            <TaskAiButton
              taskId={task.id}
              title={task.title}
              dueDate={task.dueDate}
              priority={task.priority}
            />
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              aria-label={`Edit task: ${task.title}`}
              title={editing ? 'Cancel edit' : 'Edit this task'}
              aria-expanded={editing}
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded ${
                editing
                  ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-zinc-200'
              }`}
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
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
            <TaskDeleteButton taskId={task.id} title={task.title} />
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="border-t border-zinc-100 dark:border-zinc-800">
          <td colSpan={6} className="px-4 py-3">
            <TaskEditForm
              taskId={task.id}
              initialTitle={task.title}
              initialDescription={task.description}
              initialDueDate={task.dueDate}
              initialPriority={task.priority}
              onClose={() => setEditing(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}
