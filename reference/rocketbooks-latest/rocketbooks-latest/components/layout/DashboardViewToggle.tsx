'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const COOKIE = 'rs_dash_view';
const ONE_YEAR = 60 * 60 * 24 * 365;

function readView(): 'insights' | 'summary' {
  if (typeof document === 'undefined') return 'summary';
  const m = document.cookie.match(/(?:^|;\s*)rs_dash_view=([^;]+)/);
  return m && m[1] === 'insights' ? 'insights' : 'summary';
}

/**
 * Dashboard-only toggle (rendered in the TopBar just before Tour): flips between
 * the company-snapshot summary (default) and the graph/posture insights command
 * center. Self-hides on every other page. Writes the rs_dash_view cookie the
 * dashboard server page reads, then refreshes so the chosen view renders.
 */
export function DashboardViewToggle() {
  const pathname = usePathname();
  const router = useRouter();
  const [view, setView] = useState<'insights' | 'summary'>('summary');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setView(readView());
    setMounted(true);
  }, []);

  // Only on the dashboard.
  if (pathname !== '/dashboard') return null;

  const next = view === 'insights' ? 'summary' : 'insights';
  const label = next === 'insights' ? 'Switch to insights view' : 'Switch to summary view';

  function toggle() {
    document.cookie = `${COOKIE}=${next}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    setView(next);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
    >
      {/* Show the icon of the view you'll switch TO. Until mounted, show the
          insights (bars) icon as a stable default to avoid hydration flicker. */}
      {mounted && view === 'insights' ? (
        // Grid icon → switch to summary
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      ) : (
        // Bar-chart icon → switch to insights
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
          <line x1="6" y1="20" x2="6" y2="16" />
        </svg>
      )}
      <span className="hidden sm:inline">{mounted && view === 'insights' ? 'Summary' : 'Insights'}</span>
    </button>
  );
}
