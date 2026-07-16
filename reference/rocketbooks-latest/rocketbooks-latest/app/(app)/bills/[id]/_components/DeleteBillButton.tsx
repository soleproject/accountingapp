'use client';

import { useState, useTransition } from 'react';
import { deleteBill } from '../_actions/deleteBill';

interface Props {
  billId: string;
  billLabel: string;
}

export function DeleteBillButton({ billId, billLabel }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (pending) return;
    const ok = window.confirm(
      `Delete bill ${billLabel}?\n\nIf this bill has been posted, its journal entry will be reversed (the GL effect cancels). The bill and its lines will be removed from your books.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteBill(billId);
      if (result?.error) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-zinc-950 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {pending ? 'Deleting…' : 'Delete'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
