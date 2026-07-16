'use client';

import { useEffect, useState, useTransition } from 'react';
import { useCardFlip, type FlipText } from './CardFlipContext';
import { FlipLatestMessage } from './FlipLatestMessage';
import { FlipDraftControls } from './FlipDraftControls';
import { textDraftKey, loadDraft, saveDraft, clearDraft } from './flipDraftStorage';

const MAX_CHARS = 1600;

/**
 * The editor shown on the back of the flipped Open Tasks card when a text is
 * selected. Sends through the existing /api/texts/send endpoint, which keys
 * off the contact id — so a text from a number not linked to a contact can't
 * be replied to here (we disable Send and explain why).
 */
export function FlipTextEditor({ text }: { text: FlipText }) {
  const { close } = useCardFlip();
  const to = text.contactName ?? text.fromPhone;
  const canSend = !!text.contactId;

  // Restore any saved (unsent) draft for this contact's thread on open.
  // Texts from unlinked numbers can't be replied to, so they aren't persisted.
  const draftStoreKey = text.contactId ? textDraftKey(text.contactId) : null;
  const [body, setBody] = useState(() => (draftStoreKey ? loadDraft(draftStoreKey)?.body ?? '' : ''));
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  // Persist the in-progress reply so it survives closing/navigating away.
  useEffect(() => {
    if (!draftStoreKey || sent) return;
    saveDraft(draftStoreKey, { body });
  }, [draftStoreKey, body, sent]);

  const handleSend = () => {
    setError(null);
    const trimmed = body.trim();
    if (!trimmed) {
      setError('Write a message first.');
      return;
    }
    if (!text.contactId) {
      setError('This number isn’t linked to a contact, so it can’t be replied to here.');
      return;
    }
    start(async () => {
      try {
        const res = await fetch('/api/texts/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId: text.contactId, body: trimmed }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data?.error ?? `Send failed (${res.status})`);
          return;
        }
        if (draftStoreKey) clearDraft(draftStoreKey); // sent — no draft to keep
        setSent(true);
        setTimeout(() => close(), 1000);
      } catch {
        setError('Send failed — network error.');
      }
    });
  };

  const len = body.length;

  return (
    <div className="flex h-full min-h-[calc(100vh-12rem)] flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 shadow-sm dark:bg-sky-900/40 dark:text-sky-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Text reply
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
          <span className="font-mono text-[11px]">{text.fromPhone}</span>
        </div>

        <FlipLatestMessage fallbackBody={text.body} fallbackWho={to} accent="sky" />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={pending || sent || !canSend}
          maxLength={MAX_CHARS}
          placeholder={canSend ? `Text ${to}…` : 'Reply unavailable — number not linked to a contact.'}
          className="min-h-0 flex-1 resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-sky-500 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
        />

        {error && (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <FlipDraftControls
          kind="text"
          targetId={text.contactId}
          accent="sky"
          disabled={pending || sent || !canSend}
          onDraft={(t) => setBody(t.slice(0, MAX_CHARS))}
          onError={setError}
        />
        <div className="flex items-center gap-2">
          {sent ? (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">Sent ✓</span>
          ) : (
            <span className={`text-[11px] ${len > MAX_CHARS ? 'text-rose-600' : 'text-zinc-400'}`}>
              {len} / {MAX_CHARS}
            </span>
          )}
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
            disabled={pending || sent || !canSend || !body.trim()}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Sending…' : 'Send text'}
          </button>
        </div>
      </div>
    </div>
  );
}
