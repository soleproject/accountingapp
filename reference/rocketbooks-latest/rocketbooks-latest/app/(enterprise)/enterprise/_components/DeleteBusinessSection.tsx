'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteEnterpriseBusinessAction } from '../_actions/clients';

interface Props {
  orgId: string;
  orgName: string;
}

/**
 * Danger-zone delete for a client business on the enterprise edit screen.
 * Requires typing the exact business name to confirm, then calls the
 * firm-access-checked cascade delete and returns to the businesses list.
 */
export function DeleteBusinessSection({ orgId, orgName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);

  const closeModal = () => {
    setOpen(false);
    setError(null);
    setConfirmName('');
    setResult(null);
  };

  const onConfirm = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const r = await deleteEnterpriseBusinessAction({ orgId, confirmName });
      if (r.ok) {
        setResult(r.totalRowsDeleted ?? 0);
        setTimeout(() => {
          closeModal();
          router.push('/enterprise/businesses');
          router.refresh();
        }, 1200);
      } else {
        setError(r.error ?? 'Delete failed');
      }
    });
  };

  return (
    <div className="mt-6 rounded-lg border border-red-200 bg-red-50/40 p-4 dark:border-red-900/60 dark:bg-red-950/20">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">Delete this business</h3>
          <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
            Permanently removes <strong>{orgName}</strong> and every related record. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          Delete business
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
          <div
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">Delete business</h2>
            <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              This will permanently delete <strong>{orgName}</strong> and every related record:
              transactions, journal entries, invoices, bills, contacts, accounts, imports, receipts,
              Plaid connections, onboarding state — everything.
            </p>
            <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-400">
              This action cannot be undone.
            </p>

            <label className="mt-4 block">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Type <strong className="text-zinc-700 dark:text-zinc-300">{orgName}</strong> to confirm
              </span>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                disabled={pending || result !== null}
                autoFocus
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                placeholder={orgName}
              />
            </label>

            {error && (
              <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}
            {result !== null && (
              <div className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                ✓ Deleted — {result.toLocaleString()} rows removed
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={pending}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending || result !== null || confirmName.trim() !== orgName}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {pending ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
