'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { createRequestAction, type CreateRequestState } from '../_actions/createRequest';
import type { RequestRow, Recipient } from '@/lib/signatures/store';

interface EligibleDoc {
  id: string;
  title: string;
  source: string;
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  sent: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  declined: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  voided: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function recipientSummary(recipients: Recipient[]): string {
  if (recipients.length === 0) return 'No recipients';
  const signed = recipients.filter((r) => r.status === 'signed').length;
  return `${signed}/${recipients.length} signed`;
}

export function SignaturesList({ requests, docs }: { requests: (RequestRow & { recipients: Recipient[] })[]; docs: EligibleDoc[] }) {
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Signatures</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Send documents out for signature and track who has signed.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200/70 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-sm font-medium text-indigo-700 shadow-sm transition-shadow hover:shadow-md dark:border-indigo-900/40 dark:from-indigo-950/30 dark:to-zinc-900 dark:text-indigo-300"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New request
        </button>
      </header>

      {showNew && <NewRequestPanel docs={docs} />}

      {requests.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No signature requests yet. Click <span className="font-medium">New request</span> to send a document for signature.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Recipients</th>
                <th className="px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50">
                  <td className="px-4 py-2">
                    <Link href={`/organizer/signatures/${r.id}`} className="font-medium text-zinc-800 hover:text-indigo-600 hover:underline dark:text-zinc-200 dark:hover:text-indigo-400">
                      {r.title || 'Untitled'}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[r.status] ?? STATUS_STYLE.draft}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{recipientSummary(r.recipients)}</td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400">{fmt(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewRequestPanel({ docs }: { docs: EligibleDoc[] }) {
  const [state, action, pending] = useActionState<CreateRequestState | undefined, FormData>(createRequestAction, undefined);
  const [mode, setMode] = useState<'doc' | 'upload'>(docs.length > 0 ? 'doc' : 'upload');

  return (
    <div className="rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50/60 to-white p-5 shadow-sm dark:border-indigo-900/40 dark:from-indigo-950/20 dark:to-zinc-900">
      <h2 className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Start a signature request</h2>

      <div className="mb-4 inline-flex rounded-lg bg-white p-0.5 text-xs shadow-sm dark:bg-zinc-800">
        <button
          type="button"
          onClick={() => setMode('doc')}
          className={`rounded-md px-3 py-1 font-medium ${mode === 'doc' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300' : 'text-zinc-500'}`}
        >
          From Documents
        </button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={`rounded-md px-3 py-1 font-medium ${mode === 'upload' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300' : 'text-zinc-500'}`}
        >
          Upload a PDF
        </button>
      </div>

      <form action={action} className="flex flex-col gap-3">
        {mode === 'doc' ? (
          docs.length === 0 ? (
            <p className="text-sm text-zinc-500">No eligible documents. Create one in Documents, or upload a PDF instead.</p>
          ) : (
            <select
              name="documentId"
              required
              defaultValue=""
              className="w-full max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="" disabled>
                Choose a document…
              </option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.source === 'uploaded' ? ' (PDF)' : ''}
                </option>
              ))}
            </select>
          )
        ) : (
          <input
            type="file"
            name="file"
            accept="application/pdf,.pdf"
            required
            className="max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-zinc-200 file:px-3 file:py-1 file:text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:file:bg-zinc-700 dark:file:text-zinc-100"
          />
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {pending ? 'Preparing…' : 'Continue'}
          </button>
          {state?.error && <span className="text-sm text-rose-600">{state.error}</span>}
        </div>
        <p className="text-xs text-zinc-400">Next: place signature fields and add recipients.</p>
      </form>
    </div>
  );
}
