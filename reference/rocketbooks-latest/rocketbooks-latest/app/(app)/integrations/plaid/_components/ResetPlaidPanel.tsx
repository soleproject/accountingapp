'use client';

import { useActionState, useState, useTransition } from 'react';
import { previewReset, resetPlaidDataAction, type ResetState, type ResetCounts } from '../_actions/resetPlaid';

export function ResetPlaidPanel() {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<ResetCounts | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [state, action, submitting] = useActionState<ResetState | undefined, FormData>(resetPlaidDataAction, undefined);

  const loadPreview = () => {
    setPreviewError(null);
    startTransition(async () => {
      const res = await previewReset();
      if (res.error) setPreviewError(res.error);
      else if (res.counts) setCounts(res.counts);
    });
  };

  if (!open) {
    return (
      <details className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40">
        <summary
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
            loadPreview();
          }}
          className="cursor-pointer font-medium text-red-900 dark:text-red-100"
        >
          ⚠ Danger zone — reset Plaid data for this org
        </summary>
      </details>
    );
  }

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/40">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-medium text-red-900 dark:text-red-100">⚠ Reset Plaid data for this organization</h3>
          <p className="mt-1 text-xs text-red-800 dark:text-red-200">
            Atomic deletion. Removes Plaid accounts, raw transactions, sync batches, all transactions
            with <code>reference LIKE &lsquo;plaid:%&rsquo;</code>, their JEs, JE lines, and GL rows.
            Manual JEs and other accounting data are untouched. Logs to admin_audit_log.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-zinc-700"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {state?.ok && state.counts ? (
        <div className="mt-3 rounded-md bg-emerald-100 p-3 text-sm text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100">
          ✓ Reset complete. Deleted: {Object.entries(state.counts).map(([k, v]) => `${k}=${v}`).join(', ')}.
        </div>
      ) : (
        <>
          <div className="mt-3 rounded-md border border-red-200 bg-white p-3 text-xs dark:border-red-900 dark:bg-zinc-950">
            <strong className="block text-red-900 dark:text-red-100">Will delete:</strong>
            {pending && <p className="mt-1 text-zinc-500">Loading counts…</p>}
            {previewError && <p className="mt-1 text-red-700 dark:text-red-300">{previewError}</p>}
            {counts && (
              <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums text-zinc-700 dark:text-zinc-300">
                <li>Plaid accounts: <strong>{counts.plaidAccounts}</strong></li>
                <li>Raw transactions: <strong>{counts.plaidRawTransactions}</strong></li>
                <li>Sync batches: <strong>{counts.plaidSyncBatches}</strong></li>
                <li>Imported (staged): <strong>{counts.importedTransactions}</strong></li>
                <li>Transactions (plaid:): <strong>{counts.transactions}</strong></li>
                <li>Journal entries: <strong>{counts.journalEntries}</strong></li>
                <li>JE lines: <strong>{counts.journalEntryLines}</strong></li>
                <li>GL rows: <strong>{counts.generalLedger}</strong></li>
              </ul>
            )}
          </div>

          <form action={action} className="mt-3 flex flex-wrap items-center gap-3">
            <label className="text-xs text-red-900 dark:text-red-100">
              Type <code className="rounded bg-red-200 px-1 dark:bg-red-900">RESET</code> to confirm:
            </label>
            <input
              type="text"
              name="confirm"
              autoComplete="off"
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-sm dark:border-red-800 dark:bg-zinc-950"
            />
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
            >
              {submitting ? 'Resetting…' : 'Delete all Plaid data'}
            </button>
            {state?.error && <span className="text-sm text-red-700 dark:text-red-300">{state.error}</span>}
          </form>
        </>
      )}
    </div>
  );
}
