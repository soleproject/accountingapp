'use client';

import { useEffect, useState, useTransition } from 'react';
import { sendReplyAction } from '@/app/(app)/inbox/_actions/sendReply';
import { useCardFlip, type FlipEmail } from './CardFlipContext';
import { FlipLatestMessage } from './FlipLatestMessage';
import { FlipDraftControls } from './FlipDraftControls';
import { emailDraftKey, loadDraft, saveDraft, clearDraft } from './flipDraftStorage';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text → simple HTML: blank lines split paragraphs, single newlines → <br>. */
function toHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

/**
 * The editor shown on the back of the flipped Open Tasks card. Sends a real
 * reply through the existing inbox sendReplyAction (which looks the message +
 * its email account up by id), so it only works for messages with a linked
 * account — otherwise the action returns a friendly error we surface inline.
 */
export function FlipEmailEditor({ email }: { email: FlipEmail }) {
  const { close } = useCardFlip();
  const to = email.contactName ?? email.fromName ?? email.fromAddress;
  const initialSubject = email.subject
    ? /^re:/i.test(email.subject)
      ? email.subject
      : `Re: ${email.subject}`
    : 'Re:';

  // Restore any saved (unsent) draft for this message on open.
  const draftStoreKey = emailDraftKey(email.id);
  const [subject, setSubject] = useState(() => loadDraft(draftStoreKey)?.subject ?? initialSubject);
  const [body, setBody] = useState(() => loadDraft(draftStoreKey)?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  // Persist the in-progress reply so it survives closing/navigating away.
  useEffect(() => {
    if (sent) return;
    saveDraft(draftStoreKey, { subject, body });
  }, [draftStoreKey, subject, body, sent]);

  const handleSend = () => {
    setError(null);
    const text = body.trim();
    if (!text) {
      setError('Write a message first.');
      return;
    }
    start(async () => {
      const r = await sendReplyAction({ messageId: email.id, subject, html: toHtml(text), text });
      if (!r.ok) {
        setError(r.error ?? 'Send failed');
        return;
      }
      clearDraft(draftStoreKey); // sent — no draft to keep
      setSent(true);
      // Brief confirmation, then flip back to Open Tasks.
      setTimeout(() => close(), 1000);
    });
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-12rem)] flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 shadow-sm dark:bg-amber-900/40 dark:text-amber-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Reply
          </h2>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close editor"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          To <span className="font-medium text-zinc-700 dark:text-zinc-300">{to}</span>{' '}
          <span className="font-mono text-[11px]">&lt;{email.fromAddress}&gt;</span>
        </div>

        <FlipLatestMessage fallbackBody={email.body} fallbackWho={email.fromName ?? to} accent="amber" />

        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={pending || sent}
          placeholder="Subject"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={pending || sent}
          placeholder={`Reply to ${to}…`}
          className="min-h-0 flex-1 resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-blue-500 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
        />

        {error && (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <FlipDraftControls
          kind="email"
          targetId={email.id}
          accent="amber"
          disabled={pending || sent}
          onDraft={(text) => setBody(text)}
          onError={setError}
        />
        <div className="flex items-center gap-2">
          {sent && <span className="text-sm text-emerald-600 dark:text-emerald-400">Sent ✓</span>}
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={pending || sent || !subject.trim() || !body.trim()}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
