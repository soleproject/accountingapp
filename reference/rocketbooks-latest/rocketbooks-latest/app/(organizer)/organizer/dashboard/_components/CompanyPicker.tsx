'use client';

import { useRouter, usePathname } from 'next/navigation';

interface Company {
  id: string;
  name: string;
}

interface Props {
  companies: Company[];
  selectedId: string | null;
}

/**
 * Top-of-dashboard company filter. Selecting a company pushes `?company=<id>`
 * onto the URL; the server dashboard reads it and scopes every card (tasks,
 * schedule, notes, inbox) to items linked to that company. "All companies"
 * clears the filter.
 */
export function CompanyPicker({ companies, selectedId }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    router.push(id ? `${pathname}?company=${encodeURIComponent(id)}` : pathname);
  };

  const active = !!selectedId;

  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex items-center gap-2 rounded-xl border px-3 py-2 shadow-sm transition-colors ${
          active
            ? 'border-indigo-300 bg-indigo-50/70 dark:border-indigo-800/60 dark:bg-indigo-950/30'
            : 'border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-900'
        }`}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={active ? 'text-indigo-500 dark:text-indigo-300' : 'text-zinc-400'}
          aria-hidden="true"
        >
          <path d="M3 21h18" />
          <path d="M5 21V7l8-4v18" />
          <path d="M19 21V11l-6-4" />
          <path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
        </svg>
        <select
          value={selectedId ?? ''}
          onChange={onChange}
          aria-label="Filter dashboard by company"
          className="max-w-[12rem] truncate bg-transparent text-sm font-medium text-zinc-800 focus:outline-none dark:text-zinc-100"
        >
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {active && (
        <button
          type="button"
          onClick={() => router.push(pathname)}
          className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-500 shadow-sm transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          aria-label="Clear company filter"
          title="Clear filter"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
