'use client';

import { useState, useTransition } from 'react';
import { generateInsightAction } from '../_actions/insight';

/**
 * AI "Month in review" — a plain-English summary of the business's last 6 months
 * (revenue, expenses, cash, runway). Generated on demand and cached on the org;
 * the button refreshes it.
 */
export function InsightCard({ initialSummary, initialAt, posture }: { initialSummary: string | null; initialAt: string | null; posture?: string }) {
  const [summary, setSummary] = useState(initialSummary);
  const [at, setAt] = useState(initialAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    setError(null);
    start(async () => {
      const r = await generateInsightAction(posture);
      if (r.ok) {
        setSummary(r.summary ?? '');
        setAt(r.at ?? null);
      } else {
        setError(r.error ?? 'Failed to generate');
      }
    });
  };

  return (
    <section className="rounded-lg border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/60 dark:bg-violet-950/20">
      <header className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-violet-900 dark:text-violet-200">✨ Month in review</h2>
        <button
          onClick={run}
          disabled={pending}
          className="shrink-0 rounded-md border border-violet-300 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
        >
          {pending ? 'Generating…' : summary ? 'Refresh' : 'Generate'}
        </button>
      </header>
      {summary ? (
        <>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{summary}</p>
          {at && (
            <p className="mt-2 text-[11px] text-zinc-400">
              Updated {new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {pending ? 'Analyzing your last 6 months…' : 'Generate an AI summary of how the business is doing — revenue, expenses, cash, and runway, in plain English.'}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
