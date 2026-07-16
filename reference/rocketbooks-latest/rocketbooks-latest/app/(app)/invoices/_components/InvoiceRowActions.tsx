'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { deleteInvoice } from '../[id]/_actions/deleteInvoice';

interface Props {
  invoiceId: string;
  invoiceLabel: string;
  /** Currently unused — edit is allowed for both drafts and posted (no
   *  payments) invoices, with a JE reversal on save. Kept on the prop so
   *  callers don't need to drop the field; future UX could disable the
   *  pencil here when payments are applied. */
  posted?: boolean;
}

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
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

/**
 * Per-row pencil + trash for the invoices list. Pencil is hidden for posted
 * invoices (those are read-only by design — the user has to delete and
 * re-create to make changes). Trash hits the same deleteInvoice action that
 * the detail page uses, with a confirm dialog.
 */
export function InvoiceRowActions({ invoiceId, invoiceLabel }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onDelete = () => {
    if (pending) return;
    const ok = window.confirm(
      `Delete invoice ${invoiceLabel}?\n\nIf this invoice has been posted, its journal entry will be reversed (the GL effect cancels). The invoice and its lines will be removed from your books.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteInvoice(invoiceId);
      if (result?.error) setError(result.error);
    });
  };

  return (
    <div className="flex items-center justify-end gap-1">
      <Link
        href={`/invoices/${invoiceId}/edit`}
        prefetch={false}
        title="Edit invoice"
        aria-label={`Edit invoice ${invoiceLabel}`}
        className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <PencilIcon />
      </Link>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        title="Delete invoice"
        aria-label={`Delete invoice ${invoiceLabel}`}
        className="rounded p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <TrashIcon />
      </button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </div>
  );
}
