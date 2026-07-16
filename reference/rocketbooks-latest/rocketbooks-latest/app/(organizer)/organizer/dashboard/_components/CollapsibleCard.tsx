'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Card shell with a collapse/expand toggle on the header. Used by the
 * dashboard's Inbox Issues and Texts cards so users can fold away sections
 * they don't want taking up vertical space.
 *
 * State is remembered per browser in localStorage (keyed by `storageKey`),
 * defaulting to open. We render `defaultOpen` on the server and the first
 * client paint, then reconcile from localStorage in an effect — so a section
 * the user previously collapsed may flash open for a frame, but we avoid a
 * hydration mismatch.
 *
 * The header `right` slot (a badge or link) sits OUTSIDE the toggle button so
 * we never nest an interactive element inside a <button>.
 */
interface Props {
  /** localStorage key for the persisted open/closed state. */
  storageKey: string;
  title: string;
  /** The colored icon chip shown left of the title. */
  icon: ReactNode;
  /** Optional header accessory (badge / link) shown on the right. */
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsibleCard({ storageKey, title, icon, right, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  // Hydrate the remembered state after mount (localStorage is client-only).
  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'open') setOpen(true);
    else if (stored === 'closed') setOpen(false);
  }, [storageKey]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      window.localStorage.setItem(storageKey, next ? 'open' : 'closed');
      return next;
    });
  };

  return (
    <section className="group rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="-m-1 flex flex-1 items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`shrink-0 text-zinc-400 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {icon}
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {title}
          </h2>
        </button>
        {right}
      </div>

      {open && children}
    </section>
  );
}
