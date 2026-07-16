'use client';

import { useCardFlip } from './CardFlipContext';

function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Compact "most recent message" block shown at the top of the reply editor so
 * you can see what you're replying to without flipping to the full thread.
 * Reads the latest entry from the shared thread; falls back to the selected
 * message's own body while the thread is still loading.
 */
export function FlipLatestMessage({
  fallbackBody,
  fallbackWho,
  accent,
}: {
  fallbackBody: string;
  fallbackWho: string;
  /** 'amber' for email, 'sky' for text — tints the block like the selected row. */
  accent: 'amber' | 'sky';
}) {
  const { lastMessage, threadLoading } = useCardFlip();

  const who = lastMessage?.who ?? fallbackWho;
  const body = lastMessage?.body ?? fallbackBody;
  const at = lastMessage?.at;

  const tone =
    accent === 'amber'
      ? 'border-amber-200/70 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30'
      : 'border-sky-200/70 bg-sky-50 dark:border-sky-900/40 dark:bg-sky-950/30';

  return (
    <div className={`rounded-md border px-3 py-2 ${tone}`}>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Latest message</span>
        <span className="flex items-baseline gap-2 text-[11px] text-zinc-500">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">{who}</span>
          {at && <span className="text-zinc-400">{when(at)}</span>}
          {threadLoading && !lastMessage && <span className="text-zinc-400">…</span>}
        </span>
      </div>
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
        {body}
      </p>
    </div>
  );
}
