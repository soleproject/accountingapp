'use client';

import { restoreDuplicateTransactionAction } from '../_actions/restoreDuplicate';

/**
 * Per-row action in the "Removed duplicates" bucket. Restores a quarantined
 * duplicate back to the active ledger (it returns unposted for re-categorization).
 */
export function RestoreDuplicateButton({ transactionId }: { transactionId: string }) {
  return (
    <form action={restoreDuplicateTransactionAction}>
      <input type="hidden" name="transactionId" value={transactionId} />
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        title="Move this transaction back to the active ledger (returns unposted for re-categorization)."
      >
        Restore
      </button>
    </form>
  );
}
