'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { createReturnAction, type CreateReturnState } from '../_actions/createReturn';
import type { TaxReturnRow } from '@/lib/tax/store';

const STATUS_STYLE: Record<string, string> = {
  collecting: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  crawling: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  review: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  complete: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  archived: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

const ENTITY_TYPES = [
  ['sole_prop', 'Sole proprietor'],
  ['llc', 'LLC'],
  ['partnership', 'Partnership'],
  ['s_corp', 'S-corporation'],
  ['c_corp', 'C-corporation'],
  ['beneficial_trust', 'Trust (beneficial)'],
  ['business_trust', 'Trust (business)'],
  ['nonprofit', 'Nonprofit'],
  ['other', 'Other'],
] as const;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function TaxReturnsList({ returns, defaultYear }: { returns: TaxReturnRow[]; defaultYear: number }) {
  const [showNew, setShowNew] = useState(returns.length === 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tax Returns</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Prepare federal &amp; state returns. RocketBooks identifies the forms, fills them as
            drafts, and follows each form&apos;s references until the return is complete.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-zinc-900 dark:text-indigo-300"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New return
        </button>
      </header>

      <div className="rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
        Completed forms are <span className="font-semibold">drafts for preparer review</span>, not filed returns. RocketBooks does not e-file.
      </div>

      {showNew && <NewReturnPanel defaultYear={defaultYear} />}

      {returns.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No tax returns yet. Click <span className="font-medium">New return</span> to start — or just ask the AI Assistant to &ldquo;help me do my taxes.&rdquo;
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Year</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Jurisdictions</th>
                <th className="px-4 py-2 font-medium">Forms</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-2">
                    <Link href={`/taxes/${r.id}`} className="font-medium text-zinc-800 hover:text-indigo-600 hover:underline dark:text-zinc-200 dark:hover:text-indigo-400">
                      {r.taxYear}
                    </Link>
                  </td>
                  <td className="px-4 py-2 capitalize text-zinc-600 dark:text-zinc-300">
                    {r.returnType}
                    {r.entityType ? <span className="text-zinc-400"> · {r.entityType.replace(/_/g, ' ')}</span> : null}
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{r.jurisdictions.join(', ')}</td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{r.formCount}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[r.status] ?? STATUS_STYLE.collecting}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{fmtDate(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewReturnPanel({ defaultYear }: { defaultYear: number }) {
  const [state, action, pending] = useActionState<CreateReturnState | undefined, FormData>(createReturnAction, undefined);
  const [returnType, setReturnType] = useState<'personal' | 'business'>('personal');
  const years = [defaultYear + 1, defaultYear, defaultYear - 1, defaultYear - 2];

  return (
    <div className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/60 to-white p-5 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-900">
      <h2 className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Start a tax return</h2>

      <div className="mb-4 inline-flex rounded-lg bg-white p-0.5 text-xs shadow-sm dark:bg-zinc-800">
        {(['personal', 'business'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setReturnType(t)}
            className={`rounded-md px-3 py-1 font-medium capitalize ${returnType === t ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300' : 'text-zinc-500'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="return_type" value={returnType} />

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            Tax year
            <select name="tax_year" defaultValue={defaultYear} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>

          {returnType === 'business' && (
            <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
              Entity type
              <select name="entity_type" defaultValue="" required className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
                <option value="" disabled>Choose…</option>
                {ENTITY_TYPES.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            State (optional)
            <input name="state" maxLength={2} placeholder="CA" className="w-20 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm uppercase dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100" />
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {pending ? 'Creating…' : 'Create return'}
          </button>
          {state?.error && <span className="text-sm text-rose-600">{state.error}</span>}
        </div>
        <p className="text-xs text-zinc-400">Next: record the client&apos;s facts (or ask the AI Assistant to interview them), then run the return.</p>
      </form>
    </div>
  );
}
