'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Props {
  hasActiveFilters: boolean;
  clearHref: string;
  children: React.ReactNode;
}

const STORAGE_KEY = 'rs_admin_all_users_filters_open';

/**
 * Hide/Show wrapper around the All Users filter panel. Mirrors the
 * transactions FiltersPanel pattern: client-side state persisted in
 * localStorage, defaults to expanded.
 */
export function AllUsersFilters({ hasActiveFilters, clearHref, children }: Props) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === '0') setOpen(false);
    } catch {
      // ignore
    }
  }, []);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className={`rounded-md border px-3 py-1 text-sm font-medium transition-colors ${
            open
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
          }`}
          aria-expanded={open}
        >
          {open ? '▾ Hide Filters' : '▸ Show Filters'}
        </button>
        {!open && hasActiveFilters && (
          <>
            <Link
              href={clearHref}
              className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Clear
            </Link>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">(active filters hidden)</span>
          </>
        )}
      </div>

      {open && <div>{children}</div>}
    </div>
  );
}
