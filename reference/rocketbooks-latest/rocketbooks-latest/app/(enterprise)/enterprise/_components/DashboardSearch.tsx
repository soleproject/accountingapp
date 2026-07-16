'use client';

import { useState } from 'react';

/**
 * Search box that filters every row across all dashboard tabs. The input lives
 * above the tab card, so its value survives tab switches. Filtering is done by
 * injecting a scoped <style> that hides any row whose `data-search` text doesn't
 * contain the query (case-insensitive) — so it works on the active tab's rows
 * no matter which tab is showing, without re-serializing data to the client.
 */
const SCOPE_ID = 'rs-dashboard-search-scope';

function escapeForSelector(s: string): string {
  // Escaping for use inside an attribute selector string: backslash and quote.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function DashboardSearch({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const term = query.trim();
  const css = term
    ? `#${SCOPE_ID} [data-search]:not([data-search*="${escapeForSelector(term)}" i]){display:none!important}`
    : '';

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-sm">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients, businesses, issues…"
          aria-label="Search dashboard"
          className="w-full rounded-md border border-zinc-300 bg-white py-1.5 pl-8 pr-2 text-sm text-zinc-700 shadow-sm placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        />
      </div>
      {css && <style>{css}</style>}
      <div id={SCOPE_ID}>{children}</div>
    </div>
  );
}
