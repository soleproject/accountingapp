'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import {
  softDeleteContact,
  restoreContact,
  type DeleteContactState,
  type RestoreContactState,
} from '../_actions/deleteContact';

/**
 * Per-row pencil + trash/restore actions on the contacts list.
 *   Pencil  → /contacts/[id] edit page
 *   Trash   → soft-delete (archive). Shown when isActive !== false.
 *   Restore → flip back to active. Shown when isActive === false.
 *
 * For destructive removal users go through the bulk-merge UI (combines
 * sources into a target, deletes the sources). There's no per-row hard
 * delete because the FK web makes a clean DELETE impractical.
 */
export function RowActions({
  id,
  contactName,
  isActive,
}: {
  id: string;
  contactName: string;
  isActive: boolean | null;
}) {
  return (
    <div className="flex items-center gap-1">
      <Link
        href={`/contacts/${id}`}
        prefetch={false}
        title="Edit"
        aria-label={`Edit ${contactName}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <PencilIcon />
      </Link>
      {isActive === false ? <RestoreButton id={id} contactName={contactName} /> : <ArchiveButton id={id} contactName={contactName} />}
    </div>
  );
}

function ArchiveButton({ id, contactName }: { id: string; contactName: string }) {
  const [state, action, pending] = useActionState<DeleteContactState | undefined, FormData>(
    softDeleteContact,
    undefined,
  );
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Archive "${contactName}"? It stops appearing in pickers but existing transactions keep their reference.`)) {
          e.preventDefault();
        }
      }}
      className="inline-flex"
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending || state?.ok}
        title={state?.ok ? 'Archived' : 'Archive'}
        aria-label={`Archive ${contactName}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-rose-900/30 dark:hover:text-rose-300"
      >
        {state?.ok ? <CheckIcon /> : <TrashIcon />}
      </button>
    </form>
  );
}

function RestoreButton({ id, contactName }: { id: string; contactName: string }) {
  const [state, action, pending] = useActionState<RestoreContactState | undefined, FormData>(
    restoreContact,
    undefined,
  );
  return (
    <form action={action} className="inline-flex">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending || state?.ok}
        title={state?.ok ? 'Restored' : 'Restore'}
        aria-label={`Restore ${contactName}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-300"
      >
        {state?.ok ? <CheckIcon /> : <RestoreIcon />}
      </button>
    </form>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function RestoreIcon() {
  // "Reverse arrow" — circular arrow suggesting unarchive / revive.
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
