'use client';

import { useState } from 'react';

export interface VideoInviteDraftView {
  draftId: string;
  to: string;
  toEmail: string;
  toName: string | null;
  contactId: string | null;
  subject: string;
  body: string;
  roomName: string;
  joinUrl: string;
}

export interface VideoInviteSentView {
  to: string;
  toName: string | null;
  subject: string;
  joinUrl: string;
  taskId?: string;
  taskTitle?: string;
}

function JoinButton({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
      Join the call
    </a>
  );
}

/**
 * Confirm-then-send card for a video-call invite. Preview shows the email + a
 * "Join the call" button so the host can open the room now. Send emails the
 * join link and flips to a completion view (which keeps the Join button).
 */
export function VideoInviteCard({
  draft,
  sent,
}: {
  draft?: VideoInviteDraftView;
  sent?: VideoInviteSentView;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'cancelled' | 'error'>(
    sent ? 'sent' : 'idle',
  );
  const [result, setResult] = useState<VideoInviteSentView | null>(sent ?? null);
  const [error, setError] = useState<string | null>(null);

  if (state === 'cancelled') return null;
  if (state === 'sent' && result) return <Completion c={result} />;
  if (!draft) return null;

  const send = async () => {
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/organizer/ai-actions/video-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: draft.to, subject: draft.subject, body: draft.body, joinUrl: draft.joinUrl }),
      });
      const j = (await res.json()) as VideoInviteSentView & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `send failed (${res.status})`);
      setResult({ ...j, joinUrl: draft.joinUrl });
      setState('sent');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  return (
    <div className="rounded-lg border border-sky-300 bg-white p-3 text-sm shadow-sm dark:border-sky-800 dark:bg-zinc-900">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">Video call invite</p>
      <div className="flex gap-2">
        <span className="w-16 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">To</span>
        <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">
          {draft.toName ? `${draft.toName} · ` : ''}
          <span className="text-zinc-500 dark:text-zinc-400">{draft.toEmail}</span>
        </span>
      </div>
      <div className="mt-1 flex gap-2">
        <span className="w-16 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">Subject</span>
        <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">{draft.subject}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        {draft.body}
      </p>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">+ join link: {draft.joinUrl}</p>
      {(state === 'error' || error) && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <JoinButton url={draft.joinUrl} />
        <div className="flex gap-2">
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
    </div>
  );
}

function Completion({ c }: { c: VideoInviteSentView }) {
  return (
    <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">
      <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-200">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Video invite sent to {c.toName ?? c.to}
      </p>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">They got a link to join your call.</p>
      {c.taskTitle && (
        <p className="mt-1 text-xs text-emerald-600/80 dark:text-emerald-400/80">✓ Logged: {c.taskTitle}</p>
      )}
      <div className="mt-2">
        <JoinButton url={c.joinUrl} />
      </div>
    </div>
  );
}
