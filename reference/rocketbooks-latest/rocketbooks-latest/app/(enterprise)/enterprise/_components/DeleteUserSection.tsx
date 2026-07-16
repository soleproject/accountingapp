'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteEnterpriseClientUserAction } from '../_actions/clients';

interface Props {
  userId: string;
  /** Exact text the firm must type to confirm — the user's full name (or email). */
  userName: string;
  /** How many companies this user owns; all are cascade-deleted first. */
  ownedCount: number;
}

/**
 * Danger-zone delete for a client user on the enterprise client-edit screen.
 * Deletes every company the user owns first, then the user — behind a
 * typed-name confirmation that surfaces the company count up front.
 */
export function DeleteUserSection({ userId, userName, ownedCount }: Props) {
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
      const r = await deleteEnterpriseClientUserAction({ userId, confirmName });
      if (r.ok) {
        setResult({ orgs: r.orgsDeleted ?? 0, rows: r.totalRowsDeleted ?? 0 });
        setTimeout(() => {
          closeModal();
          router.push('/enterprise/clients');
          router.refresh();
        }, 1400);
      } else {
        setError(r.error ?? 'Delete failed');
      }
    });
  };

  const companies = ownedCount === 1 ? '1 company' : `${ownedCount} companies`;

  return (
    <div className="mt-6 rounded-lg border border-red-200 bg-red-50/40 p-4 dark:border-red-900/60 dark:bg-red-950/20">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">Delete this user</h3>
          <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
            Deletes <strong>{userName}</strong>
            {ownedCount > 0 ? <> and the {companies} they own</> : null}, and every related record.
            This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          Delete user
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeModal}>
          <div
            className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-red-700 dark:text-red-400">Delete user</h2>
            <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              This permanently deletes <strong>{userName}</strong>
              {ownedCount > 0 ? (
                <>
                  {' '}
                  and first removes the <strong>{companies}</strong> they own — every transaction,
                  journal entry, invoice, bill, contact, account, import, receipt, Plaid connection
                  and onboarding record in each one.
                </>
              ) : (
                <> and their account.</>
              )}
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
                ✓ Deleted {result.orgs > 0 ? `${result.orgs} compan${result.orgs === 1 ? 'y' : 'ies'} + ` : ''}
                the user — {result.rows.toLocaleString()} rows removed
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
          </div>
        </div>
      )}
    </div>
  );
}
