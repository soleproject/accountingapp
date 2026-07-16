'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const ChevronDownIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

interface Props {
  exportHref: string;
  /** Present only for accountants (gated on canAccountantReview upstream). */
  rulesHref?: string;
  accountantViewHref?: string;
  accountantViewOn?: boolean;
  /** Opens the "Removed duplicates" bucket (quarantined cross-source dupes). */
  removedDuplicatesHref?: string;
}

/** "More ▾" dropdown — secondary header actions (Accountant view, Rules, Removed duplicates, Export CSV). */
export function MoreMenu({ exportHref, rulesHref, accountantViewHref, accountantViewOn, removedDuplicatesHref }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const itemClass =
    'block w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900';

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
      >
        More <ChevronDownIcon />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {accountantViewHref && (
            <Link href={accountantViewHref} role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
              {accountantViewOn ? 'Accountant view: on' : 'Accountant view'}
            </Link>
          )}
          {rulesHref && (
            <Link href={rulesHref} role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
              Rules
            </Link>
          )}
          {removedDuplicatesHref && (
            <Link href={removedDuplicatesHref} role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
              Removed duplicates
            </Link>
          )}
          <a href={exportHref} role="menuitem" onClick={() => setOpen(false)} className={itemClass}>
            Export CSV
          </a>
        </div>
      )}
    </div>
  );
}
