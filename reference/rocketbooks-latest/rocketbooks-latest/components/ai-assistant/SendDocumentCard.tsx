'use client';

import { useState } from 'react';

export interface SendDocumentDraftView {
  draftId: string;
  to: string;
  toEmail: string;
  toName: string | null;
  contactId: string | null;
  documentId: string;
  documentTitle: string;
  subject: string;
  body: string;
}

export interface SendDocumentSentView {
  toName: string | null;
  toEmail?: string;
  documentTitle?: string;
  viewLink?: string;
  taskTitle?: string;
}

/**
 * Confirm-then-send card for emailing a document (PDF attachment + view link).
 * Preview shows the document/recipient/note with Send / Cancel; Send attaches +
 * emails and flips to a completion view.
 */
export function SendDocumentCard({
  draft,
  sent,
}: {
  draft?: SendDocumentDraftView;
  sent?: SendDocumentSentView;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'cancelled' | 'error'>(
    sent ? 'sent' : 'idle',
  );
  const [result, setResult] = useState<SendDocumentSentView | null>(sent ?? null);
  const [error, setError] = useState<string | null>(null);

  if (state === 'cancelled') return null;
  if (state === 'sent' && result) return <Completion c={result} />;
  if (!draft) return null;

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/organizer/ai-actions/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: draft.to, documentId: draft.documentId, subject: draft.subject, body: draft.body }),
      });
      const j = (await res.json()) as SendDocumentSentView & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `send failed (${res.status})`);
      setResult(j);
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  return (
    <div className="rounded-lg border border-sky-300 bg-white p-3 text-sm shadow-sm dark:border-sky-800 dark:bg-zinc-900">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">Send document</p>
      <div className="flex gap-2">
        <span className="w-20 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">Document</span>
        <span className="min-w-0 flex-1 font-medium text-zinc-800 dark:text-zinc-200">📎 {draft.documentTitle}.pdf</span>
      </div>
      <div className="mt-1 flex gap-2">
        <span className="w-20 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">To</span>
        <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">
          {draft.toName ? `${draft.toName} · ` : ''}
          <span className="text-zinc-500 dark:text-zinc-400">{draft.toEmail}</span>
        </span>
      </div>
      <div className="mt-1 flex gap-2">
        <span className="w-20 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">Subject</span>
        <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">{draft.subject}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        {draft.body}
      </p>
      {(state === 'error' || error) && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setState('cancelled')}
          disabled={state === 'sending'}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={send}
          disabled={state === 'sending'}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function Completion({ c }: { c: SendDocumentSentView }) {
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">
      <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-200">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Sent {c.documentTitle ? `"${c.documentTitle}"` : 'document'} to {c.toName ?? c.toEmail}
      </p>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">Attached as a PDF{c.viewLink ? ' with a view link' : ''}.</p>
      {c.viewLink && (
        <a href={c.viewLink} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-emerald-700 underline dark:text-emerald-300">
          Open the document
        </a>
      )}
      {c.taskTitle && (
        <p className="mt-1 text-xs text-emerald-600/80 dark:text-emerald-400/80">✓ Logged: {c.taskTitle}</p>
      )}
    </div>
  );
}
