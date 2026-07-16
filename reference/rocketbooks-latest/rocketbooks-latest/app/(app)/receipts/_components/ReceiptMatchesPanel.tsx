'use client';

import { useState, useTransition } from 'react';
import {
  acceptReceiptMatch,
  dismissReceiptMatch,
  verifyReceiptMatch,
  undoReceiptMatch,
} from '../_actions/reviewReceiptMatch';

export interface MatchCandidate {
  suggestionId: string;
  status: 'pending' | 'auto_applied';
  applicationId: string | null;
  confidence: number;
  amountDiff: number;
  dateDiffDays: number;
  vendorMatch: boolean;
  transactionId: string;
  transactionDate: string;
  transactionAmount: number;
  transactionDescription: string | null;
  accountName: string | null;
  contactName: string | null;
}

interface Props {
  matches: MatchCandidate[];
  /** True when navigated with ?showMatches=1 — auto-opens the panel. */
  autoOpen?: boolean;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ReceiptMatchesPanel({ matches, autoOpen = false }: Props) {
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const visible = matches.filter((m) => !resolved[m.suggestionId]);
  if (matches.length === 0) return null;

  const hasAutoApplied = visible.some((m) => m.status === 'auto_applied');
  const headerAccent = hasAutoApplied
    ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900/60 dark:bg-emerald-950/20'
    : 'border-indigo-200 bg-indigo-50/40 dark:border-indigo-900/60 dark:bg-indigo-950/20';
  const headerText = hasAutoApplied
    ? { title: 'Auto-applied to transaction', titleClass: 'text-emerald-900 dark:text-emerald-200', bodyClass: 'text-emerald-700/80 dark:text-emerald-300/70' }
    : { title: 'Potential transaction matches', titleClass: 'text-indigo-900 dark:text-indigo-200', bodyClass: 'text-indigo-700/80 dark:text-indigo-300/70' };

  const dispatch = async (id: string, fn: () => Promise<{ error?: string } | undefined>, doneLabel: string) => {
    startTransition(async () => {
      const result = await fn();
      if (result?.error) setErrors((e) => ({ ...e, [id]: result.error! }));
      else setResolved((r) => ({ ...r, [id]: doneLabel }));
    });
  };

  return (
    <details
      open={autoOpen || visible.length > 0}
      className={`rounded-lg border ${headerAccent}`}
    >
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className={`text-sm font-semibold ${headerText.titleClass}`}>{headerText.title}</h2>
            <p className={`text-xs ${headerText.bodyClass}`}>
              {visible.length === 0
                ? 'All matches reviewed.'
                : hasAutoApplied
                  ? 'A high-confidence match was applied automatically. Verify it looks right or undo.'
                  : `${visible.length} candidate ${visible.length === 1 ? 'transaction' : 'transactions'} found near this receipt's amount and date.`}
            </p>
          </div>
          {visible.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${hasAutoApplied ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200'}`}>
              {visible.length}
            </span>
          )}
        </div>
      </summary>

      <div className={`border-t ${hasAutoApplied ? 'border-emerald-200 dark:border-emerald-900/60' : 'border-indigo-200 dark:border-indigo-900/60'}`}>
        {visible.length === 0 ? (
          <p className="px-4 py-4 text-sm text-zinc-500">No remaining suggestions.</p>
        ) : (
          <ul className={`divide-y ${hasAutoApplied ? 'divide-emerald-200/60 dark:divide-emerald-900/40' : 'divide-indigo-200/60 dark:divide-indigo-900/40'}`}>
            {visible.map((m) => {
              const confPct = Math.round(m.confidence * 100);
              const confTone =
                m.confidence >= 0.8
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                  : m.confidence >= 0.6
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                    : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
              const isApplied = m.status === 'auto_applied';

              return (
                <li key={m.suggestionId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                        {fmt(Math.abs(m.transactionAmount))}
                      </span>
                      <span className="text-xs text-zinc-500">·</span>
                      <span className="text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
                        {formatDate(m.transactionDate)}
                      </span>
                      {m.accountName && (
                        <>
                          <span className="text-xs text-zinc-500">·</span>
                          <span className="text-sm text-zinc-600 dark:text-zinc-300">{m.accountName}</span>
                        </>
                      )}
                      {isApplied && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                          Auto-applied
                        </span>
                      )}
                      <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${confTone}`}>
                        {confPct}% match
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {m.transactionDescription || m.contactName || 'No description'}
                      {' · '}
                      <span>
                        Δ {fmt(m.amountDiff)} · {m.dateDiffDays}d
                        {m.vendorMatch && ' · vendor match'}
                      </span>
                    </div>
                    {errors[m.suggestionId] && (
                      <p className="mt-1 text-xs text-red-600">{errors[m.suggestionId]}</p>
                    )}
                  </div>

                  <div className="flex w-full gap-2 sm:w-auto">
                    {isApplied ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (!m.applicationId) return;
                            const appId = m.applicationId;
                            dispatch(m.suggestionId, () => undoReceiptMatch(appId), 'undone');
                          }}
                          disabled={pending || !m.applicationId}
                          title="Reverse the JE, drop the splits, restore the receipt and transaction to their pre-apply state."
                          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 sm:flex-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          Undo
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch(m.suggestionId, () => verifyReceiptMatch(m.suggestionId), 'verified')}
                          disabled={pending}
                          className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 sm:flex-none"
                        >
                          Verify
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => dispatch(m.suggestionId, () => dismissReceiptMatch(m.suggestionId), 'dismissed')}
                          disabled={pending}
                          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 sm:flex-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        >
                          Dismiss
                        </button>
                        <button
                          type="button"
                          onClick={() => dispatch(m.suggestionId, () => acceptReceiptMatch(m.suggestionId), 'accepted')}
                          disabled={pending}
                          title="Marks the match as accepted (no GL changes; the auto-apply path is gated to ≥0.9 confidence + exact amount)."
                          className="flex-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 sm:flex-none"
                        >
                          Accept
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
