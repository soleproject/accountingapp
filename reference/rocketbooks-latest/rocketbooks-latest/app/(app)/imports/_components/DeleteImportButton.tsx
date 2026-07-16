'use client';

import { useState, useTransition } from 'react';
import { deleteImportAction } from '../_actions/deleteImport';

interface Props {
  importId: string;
  filename: string | null;
  transactionCount: number | null;
  onDeleted?: () => void;
}

export function DeleteImportButton({ importId, filename, transactionCount, onDeleted }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    startTransition(async () => {
      setError(null);
      const result = await deleteImportAction(importId);
      if (result.ok) {
        setConfirming(false);
        onDeleted?.();
      } else {
        setError(result.error ?? 'Delete failed');
      }
    });
  };

  if (confirming) {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="hidden text-xs text-zinc-600 dark:text-zinc-400 sm:inline">
          Delete {filename ?? 'this import'}
          {typeof transactionCount === 'number' && transactionCount > 0
            ? ` and its ${transactionCount} transactions?`
            : '?'}
        </span>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {pending ? '…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title="Delete this import (and any promoted transactions / journal entries)"
      aria-label="Delete import"
      className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
  );
}
