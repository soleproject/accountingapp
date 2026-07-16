'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildHref, CALENDAR_VIEWS, VIEW_SHORTCUT, type CalendarView } from './viewmodel';

interface Props {
  view: CalendarView;
  anchorKey: string;
  todayKey: string;
  /** Borderless trigger so the menu can sit inside the arrow nav group. */
  bare?: boolean;
}

/**
 * Google-Calendar-style view switcher: a button showing the current view with a
 * dropdown of Day / Week / Month / Year / Schedule. Single-key shortcuts
 * (D/W/M/Y/A) navigate too, ignored while typing in an input.
 */
export function ViewMenu({ view, anchorKey, todayKey, bare = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Keyboard shortcuts for switching views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      const key = e.key.toUpperCase();
      const match = CALENDAR_VIEWS.find((v) => VIEW_SHORTCUT[v] === key);
      if (match && match !== view) {
        e.preventDefault();
        router.push(buildHref(match, anchorKey, todayKey));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, view, anchorKey, todayKey]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          bare
            ? 'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium capitalize text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
            : 'inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium capitalize text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
        }
      >
        {view}
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {CALENDAR_VIEWS.map((v) => (
            <Link
              key={v}
              role="menuitem"
              href={buildHref(v, anchorKey, todayKey)}
              onClick={close}
              className={`flex items-center justify-between px-3 py-1.5 text-sm capitalize ${
                v === view
                  ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900'
              }`}
            >
              {v}
              <span className="text-xs text-zinc-400 dark:text-zinc-600">{VIEW_SHORTCUT[v]}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
