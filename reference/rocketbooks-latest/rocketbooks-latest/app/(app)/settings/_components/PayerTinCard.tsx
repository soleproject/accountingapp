'use client';

import { useState, useTransition } from 'react';
import { setPayerTin } from '../_actions/payerTin';

/**
 * Payer TIN/EIN used when generating 1099-NEC forms for vendors. The form also
 * uses the org's name/address/phone, which live elsewhere in org settings.
 */
export function PayerTinCard({ initial }: { initial: string | null }) {
  const [value, setValue] = useState(initial ?? '');
  const [saved, setSaved] = useState<string | null>(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dirty = value !== (saved ?? '');

  const save = () => {
    setError(null);
    startTransition(async () => {
      const r = await setPayerTin(value);
      if (r.ok) setSaved(value);
      else setError(r.error ?? 'Save failed');
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">1099 Filing</h2>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          Your business’s Tax ID (EIN), printed as the payer on the 1099-NEC forms you generate from the 1099 Summary report.
        </p>
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Payer TIN / EIN</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="12-3456789"
            className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={isPending || !dirty}
            className="w-fit rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
          {!dirty && saved && !isPending && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    </section>
  );
}
