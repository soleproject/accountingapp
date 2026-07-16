'use client';

import { useCardFlip } from './CardFlipContext';
import { FlipThread } from './FlipThread';

/**
 * Back face of the left column: the full conversation thread for whatever
 * message is currently open in the reply editor. The thread is loaded once per
 * selection by the CardFlip provider; this panel just renders it in the shared
 * FlipThread transcript, styled to match the reply editor card on the right.
 */
export function FlipHistoryPanel() {
  const { target, thread, threadLoading, threadError, toggleHistory } = useCardFlip();

  const accent: 'amber' | 'sky' = target?.kind === 'text' ? 'sky' : 'amber';
  const who =
    target?.kind === 'email'
      ? target.contactName ?? target.fromName ?? target.fromAddress
      : target?.kind === 'text'
        ? target.contactName ?? target.fromPhone
        : '';

  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 shadow-sm dark:bg-zinc-800 dark:text-zinc-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Conversation{who ? ` · ${who}` : ''}
          </h2>
        </div>
        <button
          type="button"
          onClick={toggleHistory}
          aria-label="Close conversation"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <FlipThread entries={thread} loading={threadLoading} error={threadError} accent={accent} />
      </div>
    </div>
  );
}
