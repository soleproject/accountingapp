'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { deleteReceipt } from '../_actions/deleteReceipt';

interface Props {
  receiptId: string;
  receiptLabel: string;
}

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
  </svg>
);

export function ReceiptRowActions({ receiptId, receiptLabel }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onDelete = () => {
    if (pending) return;
    const ok = window.confirm(
      `Delete receipt ${receiptLabel}?\n\nIf this receipt has been posted, its journal entry will be reversed (the GL effect cancels). The receipt will be removed from your books.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteReceipt(receiptId);
      if (result?.error) setError(result.error);
    });
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Link
        href={`/receipts/${receiptId}`}
        title="View receipt"
        aria-label={`View receipt ${receiptLabel}`}
        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <EyeIcon />
      </Link>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        title="Delete receipt"
        aria-label={`Delete receipt ${receiptLabel}`}
        className="rounded p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <TrashIcon />
      </button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </div>
  );
}
