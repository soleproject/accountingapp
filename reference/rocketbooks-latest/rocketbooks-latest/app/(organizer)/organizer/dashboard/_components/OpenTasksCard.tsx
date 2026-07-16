import Link from 'next/link';
import { TaskAiButton } from './TaskAiButton';
import { TaskDeleteButton } from './TaskDeleteButton';
import { TaskRowTitle } from './TaskRowTitle';

interface Task {
  id: string;
  title: string;
  dueDate: string | null;
  priority: string | null;
}

interface Props {
  tasks: Task[];
  totalOpen: number;
}

function shortDue(due: string | null): string {
  if (!due) return '';
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return '';
  const diffDays = Math.floor((dueMs - Date.now()) / 86_400_000);
  if (diffDays < 0) return `${Math.abs(diffDays)}d late`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return new Date(dueMs).toLocaleDateString();
}

export function OpenTasksCard({ tasks, totalOpen }: Props) {
  return (
    <section className="group h-full rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 shadow-sm dark:bg-emerald-900/40 dark:text-emerald-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Open tasks
          </h2>
        </div>
        <Link
          href="/organizer/tasks"
          className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300 dark:hover:bg-emerald-900/50"
        >
          {totalOpen} total →
        </Link>
      </div>

      {tasks.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">No open tasks.</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-zinc-100 dark:divide-zinc-900">
          {tasks.map((t) => {
            const due = shortDue(t.dueDate);
            const overdue = t.dueDate ? Date.parse(t.dueDate) < new Date().getTime() - 86_400_000 : false;
            return (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <TaskRowTitle taskId={t.id} title={t.title} />
                <div className="flex shrink-0 items-center gap-2">
                  {due && (
                    <span
                      className={`text-xs ${
                        overdue
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-zinc-500 dark:text-zinc-400'
                      }`}
                    >
                      {due}
                    </span>
                  )}
                  <TaskAiButton
                    taskId={t.id}
                    title={t.title}
                    dueDate={t.dueDate}
                    priority={t.priority}
                  />
                  <TaskDeleteButton taskId={t.id} title={t.title} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
