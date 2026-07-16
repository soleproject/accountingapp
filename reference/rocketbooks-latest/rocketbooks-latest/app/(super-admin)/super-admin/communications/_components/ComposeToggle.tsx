'use client';

import { useState } from 'react';

interface Props {
  /** Label shown on the button when the compose form is hidden. */
  openLabel: string;
  /** Label shown on the button when the compose form is visible. */
  closeLabel?: string;
  /** The compose panel — rendered conditionally below the button. */
  children: React.ReactNode;
}

/**
 * Local-state toggle that shows/hides a compose form. Per-tab — switching
 * tabs unmounts and remounts the wrapper, so the form re-closes when you
 * come back, which matches "click Compose to start composing" intent.
 */
export function ComposeToggle({ openLabel, closeLabel = 'Hide', children }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={
            open
              ? 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900'
              : 'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700'
          }
        >
          {open ? closeLabel : openLabel}
        </button>
      </div>
      {open && children}
    </div>
  );
}
