'use client';

import { useMemo, useState } from 'react';
import { TASK_CATALOG, defaultOwnerFor, type CatalogTask, type TaskOwner } from '@/lib/enterprise/task-catalog';
import { TaskResponsibilitiesMatrix } from './TaskResponsibilitiesMatrix';

const toBase = (b: string): 'firm' | 'client' | null => (b === 'firm' ? 'firm' : b === 'client' ? 'client' : null);

/**
 * Enterprise "Default responsibilities" editor: the "who does the books?" radio
 * feeds the matrix's smart-default base LIVE. Bookkeeping tasks (the ones that
 * follow who keeps the books) re-base to the selected books answer when it
 * changes; tasks the firm explicitly set away from their books-smart default are
 * kept. Lives inside the settings <form> (setEnterpriseDefaultResponsibilitiesAction
 * reads defaultBooksManagedBy + resp_<key>). 'both' bases bookkeeping on Pro (the
 * firm oversees by default; client-books clients are handled per business).
 */
export function EnterpriseDefaultsForm({
  defaults,
  initialBooks,
}: {
  defaults: Record<string, TaskOwner>;
  initialBooks: string;
}) {
  const [books, setBooks] = useState<'firm' | 'client' | 'both'>(
    initialBooks === 'firm' || initialBooks === 'client' ? initialBooks : 'both',
  );

  // Tasks the firm set AWAY from their (saved) books-smart default — kept
  // regardless of the books selection. Everything else follows the books choice.
  const savedBase = toBase(initialBooks);
  const deviations = useMemo(() => {
    const d: Record<string, TaskOwner> = {};
    for (const t of TASK_CATALOG) {
      const saved = defaults[t.key];
      if ((saved === 'pro' || saved === 'client') && saved !== defaultOwnerFor(t, savedBase)) {
        d[t.key] = saved;
      }
    }
    return d;
  }, [defaults, savedBase]);

  const base = toBase(books);
  const ownerFor = (t: CatalogTask): TaskOwner => deviations[t.key] ?? defaultOwnerFor(t, base);

  const OPTIONS = [
    ['both', 'Both — we do the books for some clients and oversee others (default)'],
    ['firm', 'Our firm does the books'],
    ['client', 'Client does the books (we oversee)'],
  ] as const;

  return (
    <>
      <div className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="text-sm font-medium">Default: who does the books?</div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Applied to new client businesses and used as the starting point for the matrix below. Choose{' '}
          <span className="font-medium">Both</span> if you have a mix — you do the books for some clients and oversee
          others who keep their own — and you&apos;ll pick per business.
        </p>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          {OPTIONS.map(([val, label]) => (
            <label key={val} className="flex items-center gap-2">
              <input
                type="radio"
                name="defaultBooksManagedBy"
                value={val}
                checked={books === val}
                onChange={() => setBooks(val)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {/* key={books} re-mounts the matrix so the bookkeeping rows re-check to the
          new books base; any un-saved manual tweaks reset on a books change. */}
      <TaskResponsibilitiesMatrix key={books} ownerFor={ownerFor} />
    </>
  );
}
