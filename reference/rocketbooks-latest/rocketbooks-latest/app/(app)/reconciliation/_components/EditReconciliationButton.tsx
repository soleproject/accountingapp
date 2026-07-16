'use client';

import { useRef } from 'react';
import { editReconciliationPeriodAction } from '../_actions';

interface PeriodLite {
  id: string;
  startDate: string | null;
  endDate: string | null;
  statementOpening: string | null;
  statementClosing: string | null;
  accountName: string | null;
}

/**
 * Pencil button on each reconciliation row that opens a small modal to edit the
 * statement window + beginning/ending balances (same fields as "New
 * reconciliation"). Saving re-checks against the ledger and marks the period as
 * a manual override so the engine won't overwrite the edited figures.
 */
export function EditReconciliationButton({ period }: { period: PeriodLite }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        title="Edit dates & balances"
        aria-label="Edit reconciliation"
        onClick={() => dialogRef.current?.showModal()}
        className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14.3 3.2a1.7 1.7 0 0 1 2.4 2.4L7 15.3l-3.2.9.9-3.2 9.6-9.8Z" />
        </svg>
      </button>

      <dialog
        ref={dialogRef}
        className="m-auto w-[min(92vw,28rem)] rounded-lg border border-zinc-200 bg-white p-0 shadow-xl backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-950"
      >
        <form
          action={editReconciliationPeriodAction}
          onSubmit={() => dialogRef.current?.close()}
          className="flex flex-col gap-3 p-5"
        >
          <input type="hidden" name="periodId" value={period.id} />
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Edit reconciliation</h2>
            <p className="text-xs text-zinc-500">{period.accountName ?? 'Account'}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Statement start date
              <input type="date" name="fromDate" required defaultValue={period.startDate ?? ''} className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Statement end date
              <input type="date" name="toDate" required defaultValue={period.endDate ?? ''} className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Beginning balance
              <input type="number" step="0.01" name="beginningBalance" defaultValue={period.statementOpening ?? ''} placeholder="Optional" className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              Ending balance
              <input type="number" step="0.01" name="endingBalance" required defaultValue={period.statementClosing ?? ''} placeholder="From the statement" className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900" />
            </label>
          </div>

          <p className="text-[11px] text-zinc-400">
            Saving re-checks against the ledger and keeps these figures (the auto-reconciler won&rsquo;t overwrite them).
          </p>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
              Save
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
