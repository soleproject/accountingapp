'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteBusinessAction } from '../_actions/deleteBusiness';

interface Props {
  orgId: string;
  orgName: string;
  isCurrent: boolean;
  isOnlyOrg: boolean;
}

export function DeleteBusinessButton({ orgId, orgName, isCurrent, isOnlyOrg }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<number | null>(null);

  // The only blocker now is "you're on the current org AND there are others to switch to".
  // Deleting your last/only business is allowed — the server creates a fresh one and sends
  // you to the AI assistant to onboard.
  const blocker = isCurrent && !isOnlyOrg
    ? 'This business is currently active. Switch to a different one (top-left dropdown), then come back to delete it.'
    : null;

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
      const r = await deleteBusinessAction({ orgId, confirmName });
      if (r.ok) {
        setResult(r.totalRowsDeleted ?? 0);
        setTimeout(() => {
          closeModal();
          if (r.redirectTo) {
            router.push(r.redirectTo);
          } else {
            router.refresh();
          }
        }, 1200);
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
        title={blocker ?? `Delete ${orgName} and ALL related records`}
        aria-label={`Delete ${orgName}`}
        className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
        </svg>
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
            <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">Delete business</h2>

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
                  This will permanently delete <strong>{orgName}</strong> and every related record:
                  transactions, journal entries, invoices, bills, contacts, accounts, imports,
                  receipts, Plaid connections, onboarding state — everything.
                </p>
                {isOnlyOrg && (
                  <p className="mt-2 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                    This is your only business. Once deleted, a fresh empty business will be created and the AI assistant will help you set it up.
                  </p>
                )}
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
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
