'use client';

import { useState } from 'react';

/**
 * Toggles the Client Businesses list between two server-rendered views:
 *  - off (default): the compact `.ent-table-view` table
 *  - on:            the `.ent-cards-view` cards, each with the client's
 *                   monthly bookkeeping timeline.
 * A scoped CSS class hides whichever view isn't active.
 */
export function ClientTimelineToggle({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);

  return (
    <div className={show ? '[&_.ent-table-view]:hidden' : '[&_.ent-cards-view]:hidden'}>
      <div className="mb-3 flex items-center justify-end">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          <span>Show monthly timeline</span>
          <span className="relative">
            <input
              type="checkbox"
              checked={show}
              onChange={(e) => setShow(e.target.checked)}
              className="peer sr-only"
            />
            <span className="block h-5 w-9 rounded-full bg-zinc-300 transition-colors peer-checked:bg-blue-600 dark:bg-zinc-700" />
            <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
          </span>
        </label>
      </div>
      {children}
    </div>
  );
}
