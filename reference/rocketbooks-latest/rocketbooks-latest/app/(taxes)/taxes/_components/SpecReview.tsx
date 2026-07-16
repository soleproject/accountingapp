'use client';

import { useActionState } from 'react';
import { reviewSpecAction, type ReviewSpecState } from '../_actions/reviewSpec';
import type { SpecReviewData } from '@/lib/tax/review';

const TRUST_STYLE: Record<string, string> = {
  learned: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  verified: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  locked: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
  deprecated: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
};

const TONE_BTN: Record<string, string> = {
  approve: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  neutral: 'border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
  reject: 'bg-rose-600 hover:bg-rose-700 text-white',
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function SpecReview({ data }: { data: SpecReviewData }) {
  const [state, action, pending] = useActionState<ReviewSpecState | undefined, FormData>(reviewSpecAction, undefined);
  const { spec } = data;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {data.formCode} <span className="text-base font-normal text-zinc-400">{data.jurisdiction} · {data.taxYear}</span>
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{spec.title}</p>
          <p className="mt-1 text-xs text-zinc-400">
            Learned {fmt(data.createdAt)}
            {data.model ? ` · ${data.model}` : ''}
            {data.confidence !== null ? ` · model confidence ${Math.round(data.confidence * 100) / 100}` : ''}
            {' · '}
            <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">official form PDF ↗</a>
          </p>
        </div>
        <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium capitalize ${TRUST_STYLE[data.trustStatus]}`}>
          {data.trustStatus}
        </span>
      </header>

      <div className="rounded-xl border border-zinc-200/70 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
        This is shared knowledge — how to fill this form, learned once and reused for every client. Verifying it here marks forms filled with it as no longer drafts. Check each mapping against the official PDF before approving.
      </div>

      {/* Review actions */}
      <section className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Review decision</h2>
        {data.allowedTransitions.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No actions available from <span className="font-medium">{data.trustStatus}</span>.</p>
        ) : (
          <form action={action} className="flex flex-col gap-3">
            <input type="hidden" name="spec_id" value={data.specId} />
            <textarea
              name="notes"
              rows={2}
              placeholder="Review notes (optional) — what you checked, what you changed…"
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <div className="flex flex-wrap items-center gap-2">
              {data.allowedTransitions.map((t) => (
                <button
                  key={t.to}
                  type="submit"
                  name="to_status"
                  value={t.to}
                  disabled={pending}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-50 ${TONE_BTN[t.tone] ?? TONE_BTN.neutral}`}
                >
                  {t.label}
                </button>
              ))}
              {state?.error && <span className="text-sm text-rose-600">{state.error}</span>}
              {state?.ok && <span className="text-sm text-emerald-600">Updated to {state.newStatus}.</span>}
            </div>
          </form>
        )}
      </section>

      {/* Field mappings */}
      <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Field mappings</h2>
          <span className="text-xs text-zinc-400">{spec.fields.length}</span>
        </div>
        {spec.fields.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No field mappings — the AI couldn&apos;t confidently match any field. Needs manual mapping before this form fills usefully.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Input key</th>
                <th className="px-4 py-2 font-medium">PDF field</th>
                <th className="px-4 py-2 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {spec.fields.map((f) => (
                <tr key={f.acroField} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-1.5 font-mono text-xs text-indigo-700 dark:text-indigo-300">{f.key}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">{f.acroField}</td>
                  <td className="px-4 py-1.5 text-zinc-500 dark:text-zinc-400">{f.type}{typeof f.page === 'number' ? ` · p${f.page}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Dependencies */}
      <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Dependencies (forms this pulls in)</h2>
          <span className="text-xs text-zinc-400">{spec.dependencies.length}</span>
        </div>
        {spec.dependencies.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No dependencies.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {spec.dependencies.map((d, i) => (
              <li key={`${d.formCode}:${i}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {d.formCode} <span className="text-xs font-normal text-zinc-400">{d.jurisdiction} · {d.relationship} · {d.multiplicity}</span>
                </span>
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{d.condition || '(always)'}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Review history */}
      {data.history.length > 0 && (
        <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Review history</h2>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.history.map((h) => (
              <li key={h.id} className="px-4 py-2 text-sm">
                <span className="text-zinc-700 dark:text-zinc-200">
                  {h.fromStatus} → <span className="font-medium">{h.toStatus}</span>
                </span>
                <span className="ml-2 text-xs text-zinc-400">{h.reviewerEmail ?? 'unknown'} · {fmt(h.createdAt)}</span>
                {h.notes && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{h.notes}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
