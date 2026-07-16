'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * A "← Back to tasks" link shown on any page the user was taken to from the
 * Tasks page (via a card or the AI walk-through) — keyed off ?from=tasks.
 * Rendered once at the top of the app content so every destination gets it.
 */
export function BackToTasksBanner() {
  const params = useSearchParams();
  if (params.get('from') !== 'tasks') return null;
  return (
    <Link
      prefetch={false}
      href="/tasks"
      className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
    >
      ← Back to tasks
    </Link>
  );
}
