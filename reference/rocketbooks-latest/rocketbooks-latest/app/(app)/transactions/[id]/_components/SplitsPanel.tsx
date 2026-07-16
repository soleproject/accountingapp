'use client';

import { useActionState } from 'react';
import type { UnsplitTransactionState } from '../_actions/unsplitTransaction';

interface SplitRow {
  id: string;
  categoryLabel: string;
  contactLabel: string | null;
  memo: string | null;
  amount: number;
}

interface Props {
  transactionId: string;
  splits: SplitRow[];
  unsplitAction: (
    prev: UnsplitTransactionState | undefined,
    formData: FormData,
  ) => Promise<UnsplitTransactionState | undefined>;
  /** Switch to inline edit mode. */
  onEdit?: () => void;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export function SplitsPanel({ splits, unsplitAction, onEdit }: Props) {
  const [state, formAction, pending] = useActionState<UnsplitTransactionState | undefined, FormData>(
    unsplitAction,
    undefined,
  );
  const total = splits.reduce((s, l) => s + l.amount, 0);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
            Split
          </span>
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Allocated across {splits.length} categories
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:bg-zinc-900"
          >
            Edit splits
          </button>
          <form action={formAction}>
            <button
              type="submit"
              disabled={pending}
              onClick={(e) => {
                if (!confirm('Remove the split and collapse to the first category? You can re-categorize afterward.')) {
                  e.preventDefault();
                }
              }}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              {pending ? 'Removing…' : 'Remove split'}
            </button>
          </form>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left dark:bg-zinc-900">
          <tr>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Category</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Customer</th>
            <th className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Memo</th>
            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">Amount</th>
          </tr>
        </thead>
        <tbody>
          {splits.map((s) => (
            <tr key={s.id} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="px-4 py-2 text-zinc-900 dark:text-zinc-100">{s.categoryLabel}</td>
              <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{s.contactLabel || '—'}</td>
              <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{s.memo || '—'}</td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{fmt(s.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-t border-zinc-200 dark:border-zinc-800">
            <td colSpan={3} className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
              Total
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-medium">{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
      {state?.error && <p className="border-t border-zinc-100 px-4 py-2 text-sm text-red-600 dark:border-zinc-800">{state.error}</p>}
    </div>
  );
}
