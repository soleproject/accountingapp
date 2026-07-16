'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  bulkRecategorizeJeLines,
  type BulkRecategorizeResult,
} from '../_actions/bulkRecategorizeJeLines';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
}

interface Props {
  formId: string;
  fromAccountId: string;
  accounts: Account[];
  /** Display name — "invoices" or "bills" — used in the count label only. */
  noun: string;
}

/**
 * Bulk-recategorize bar for the invoice/bill sections of the account
 * drill-down. Row checkboxes carry the journal-entry id and link via the
 * shared `form` attribute, same pattern the transactions BulkBar uses.
 */
export function SourceDocBulkBar({ formId, fromAccountId, accounts, noun }: Props) {
  const [state, action, pending] = useActionState<BulkRecategorizeResult | undefined, FormData>(
    bulkRecategorizeJeLines,
    undefined,
  );
  const [count, setCount] = useState(0);

  useEffect(() => {
    const recount = () => {
      const checked = document.querySelectorAll<HTMLInputElement>(
        `input[form="${formId}"][name="journalEntryIds"]:checked`,
      );
      setCount(checked.length);
    };
    document.addEventListener('change', recount);
    recount();
    return () => document.removeEventListener('change', recount);
  }, [formId]);

  if (count === 0 && !state) return null;

  return (
    <form
      id={formId}
      action={action}
      className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-900/20"
    >
      <input type="hidden" name="fromAccountId" value={fromAccountId} />
      <span className="font-medium text-blue-900 dark:text-blue-100">
        {count} {noun} selected
      </span>
      <select
        name="toAccountId"
        required
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="">— Repoint to account —</option>
        {accounts
          .filter((a) => a.id !== fromAccountId)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber} · {a.accountName}
            </option>
          ))}
      </select>
      <button
        type="submit"
        disabled={pending || count === 0}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        {pending ? 'Repointing…' : `Recategorize ${count}`}
      </button>
      {state?.error && <span className="text-red-600">{state.error}</span>}
      {state?.ok && (
        <span className="text-emerald-700 dark:text-emerald-300">
          Repointed {state.updated} line{state.updated === 1 ? '' : 's'}.
        </span>
      )}
    </form>
  );
}
