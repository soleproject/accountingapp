'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { ReportBasis } from '@/lib/reports/basis-filter';

interface Props {
  basis: ReportBasis;
}

/**
 * Cash / Accrual toggle for the period reports. Selecting a basis:
 *   1. Persists it to the org via /api/org/accounting-method (so future
 *      page loads default to it without a URL param), and
 *   2. Rewrites the `basis` URL param so the current page re-renders.
 * Server-side loaders honor the URL param when present, else read the
 * org default.
 */
export function BasisToggle({ basis }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const select = (next: ReportBasis) => {
    if (next === basis) return;
    // Fire-and-forget the persistence call. The URL update below will
    // refresh the page either way; if the API fails the URL still wins
    // for the current session.
    void fetch('/api/org/accounting-method', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basis: next }),
      cache: 'no-store',
    }).catch(() => {});

    const params = new URLSearchParams(searchParams.toString());
    params.set('basis', next);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div
      className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 text-xs dark:border-zinc-800 dark:bg-zinc-950"
      title="Cash basis: revenue / expense recognized only when cash actually moves (excludes invoice and bill JEs). Accrual: revenue / expense recognized when invoiced / billed."
    >
      {(['accrual', 'cash'] as const).map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => select(b)}
          className={`rounded px-3 py-1 transition-colors ${
            basis === b
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
          }`}
        >
          {b === 'accrual' ? 'Accrual' : 'Cash'}
        </button>
      ))}
    </div>
  );
}
