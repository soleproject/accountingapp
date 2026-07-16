'use client';

import { useActionState, useState } from 'react';
import { importCsv, type ImportState } from '../_actions/importCsv';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}

export function ImportForm({ accounts }: { accounts: Account[] }) {
  const [state, action, pending] = useActionState<ImportState | undefined, FormData>(importCsv, undefined);
  const [filename, setFilename] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRowCount(text.split('\n').filter((l) => l.trim()).length - 1);
    };
    reader.readAsText(f);
  };

  return (
    <form action={action} className="flex flex-col gap-5 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Bank account (target)</label>
          <select
            name="accountId"
            required
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">— Select —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} · {a.accountName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">CSV file</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          onChange={onFile}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-200 file:px-3 file:py-1 file:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:file:bg-zinc-700 dark:file:text-zinc-100"
        />
        {filename && (
          <p className="text-xs text-zinc-500">
            {filename}
            {rowCount != null && rowCount >= 0 && ` · ~${rowCount} rows`}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Importing…' : 'Import CSV'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
        {state?.ok && (
          <span className="text-sm text-emerald-600">
            Imported {state.created} row{state.created === 1 ? '' : 's'}.
            {state.skipped ? ` Skipped ${state.skipped}.` : ''}
          </span>
        )}
      </div>
    </form>
  );
}
