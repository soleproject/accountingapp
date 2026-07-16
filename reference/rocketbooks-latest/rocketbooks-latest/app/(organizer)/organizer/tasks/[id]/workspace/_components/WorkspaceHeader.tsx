import Link from 'next/link';

interface Props {
  title: string;
  priority: string | null;
  /** Pre-computed on the server (date math is impure for render). */
  dueLabel: string | null;
  isOverdue: boolean;
}

/**
 * The workspace hero — the same "Next up" visual language as the dashboard's
 * NextUpCard, but it spotlights the ACTUAL task the user opened (not the single
 * most-urgent one) and links back to the task list instead of into it.
 *
 * Date math (relative due, overdue flag) is done on the server and passed in,
 * keeping this component pure.
 */
function SparkChip() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 shadow-sm dark:bg-indigo-900/40 dark:text-indigo-300">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    </span>
  );
}

export function WorkspaceHeader({ title, priority, dueLabel, isOverdue }: Props) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/30 dark:via-zinc-900 dark:to-zinc-900">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-indigo-400/10 blur-2xl dark:bg-indigo-500/10" aria-hidden="true" />
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <SparkChip />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-indigo-700/80 dark:text-indigo-300/80">
            Working on
          </h2>
        </div>
        {dueLabel && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold shadow-sm ${
              isOverdue
                ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'
            }`}
          >
            {dueLabel}
          </span>
        )}
      </div>
      <h1 className="relative mt-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
      <div className="relative mt-1 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        {priority && <span>Priority: {priority}</span>}
        <Link href="/organizer/tasks" className="hover:underline">
          ← Back to tasks
        </Link>
      </div>
    </section>
  );
}
