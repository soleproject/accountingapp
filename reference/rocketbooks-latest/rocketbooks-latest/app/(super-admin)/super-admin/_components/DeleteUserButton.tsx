'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteUserAction } from '../_actions/admin';

interface Props {
  userId: string;
  userName: string;
  /** When set, the modal opens to a blocker message instead of the confirm form. */
  blocker?: string | null;
}

export function DeleteUserButton({ userId, userName, blocker }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orgs: number; rows: number } | null>(null);

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
      const r = await deleteUserAction({ userId, confirmName });
      if (r.ok) {
        setResult({ orgs: r.orgsDeleted ?? 0, rows: r.totalRowsDeleted ?? 0 });
        setTimeout(() => {
          closeModal();
          router.push(r.redirectTo ?? '/super-admin/all-users');
          router.refresh();
        }, 1500);
      } else {
        setError(r.error ?? 'Delete failed');
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={blocker ?? `Delete ${userName} and every company they own`}
        className="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
        Delete
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">Delete user</h2>

            {blocker ? (
              <>
                <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  {blocker}
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Got it
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
                  This will permanently delete <strong>{userName}</strong>. Every company
                  this user owns will be cascade-deleted first — including all transactions,
                  journal entries, invoices, bills, contacts, accounts, imports, receipts,
                  Plaid connections, and onboarding state.
                </p>
                <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-400">
                  This action cannot be undone.
                </p>

                <label className="mt-4 block">
                  <span className="text-xs uppercase tracking-wide text-zinc-500">
                    Type <strong className="text-zinc-700 dark:text-zinc-300">{userName}</strong> to confirm
                  </span>
                  <input
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    disabled={pending || result !== null}
                    autoFocus
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    placeholder={userName}
                  />
                </label>

                {error && (
                  <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
                    {error}
                  </div>
                )}
                {result !== null && (
                  <div className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
                    ✓ Deleted — {result.orgs} {result.orgs === 1 ? 'company' : 'companies'},{' '}
                    {result.rows.toLocaleString()} rows removed
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
                    disabled={pending || result !== null || confirmName.trim() !== userName}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    {pending ? 'Deleting…' : 'Delete forever'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
