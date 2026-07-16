'use client';

import { useState } from 'react';

export interface SignatureDraftView {
  draftId: string;
  to: string;
  toEmail: string;
  toName: string | null;
  contactId: string | null;
  documentId: string;
  documentTitle: string;
}

export interface SignatureSentView {
  toName: string | null;
  toEmail?: string;
  documentTitle?: string;
  signingUrl?: string;
  taskTitle?: string;
}

/**
 * Confirm-then-send card for sending a document for e-signature. Preview shows
 * the document + recipient with Send / Cancel; Send freezes + emails the
 * signing link and flips to a completion view.
 */
export function SignatureRequestCard({
  draft,
  sent,
}: {
  draft?: SignatureDraftView;
  sent?: SignatureSentView;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'cancelled' | 'error'>(
    sent ? 'sent' : 'idle',
  );
  const [result, setResult] = useState<SignatureSentView | null>(sent ?? null);
  const [error, setError] = useState<string | null>(null);

  if (state === 'cancelled') return null;
  if (state === 'sent' && result) return <Completion c={result} />;
  if (!draft) return null;

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/organizer/ai-actions/signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: draft.to, documentId: draft.documentId }),
      });
      const j = (await res.json()) as SignatureSentView & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `send failed (${res.status})`);
      setResult(j);
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  return (
    <div className="rounded-lg border border-violet-300 bg-white p-3 text-sm shadow-sm dark:border-violet-800 dark:bg-zinc-900">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">Send for signature</p>
      <div className="flex gap-2">
        <span className="w-20 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">Document</span>
        <span className="min-w-0 flex-1 font-medium text-zinc-800 dark:text-zinc-200">{draft.documentTitle}</span>
      </div>
      <div className="mt-1 flex gap-2">
        <span className="w-20 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">Signer</span>
        <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">
          {draft.toName ? `${draft.toName} · ` : ''}
          <span className="text-zinc-500 dark:text-zinc-400">{draft.toEmail}</span>
        </span>
      </div>
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
          className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : 'Send for signature'}
        </button>
      </div>
    </div>
  );
}

function Completion({ c }: { c: SignatureSentView }) {
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">
      <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-200">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Sent {c.documentTitle ? `"${c.documentTitle}"` : 'document'} to {c.toName ?? c.toEmail} for signature
      </p>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">They got a secure link to review and sign.</p>
      {c.taskTitle && (
        <p className="mt-1 text-xs text-emerald-600/80 dark:text-emerald-400/80">✓ Logged: {c.taskTitle}</p>
      )}
    </div>
  );
}
