'use client';

import { useEffect, useRef } from 'react';

export interface ThreadEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  who: string;
  at: string;
  body: string;
}

function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Scrollable conversation transcript shown in the flip editor's staging area,
 * above the reply box. Inbound messages sit left (gray), the user's own
 * messages sit right (accent). Auto-scrolls to the most recent on load.
 */
export function FlipThread({
  entries,
  loading,
  error,
  accent,
}: {
  entries: ThreadEntry[];
  loading: boolean;
  error: string | null;
  /** 'amber' for email, 'sky' for text — tints the outbound bubbles. */
  accent: 'amber' | 'sky';
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, loading]);

  const outboundTone =
    accent === 'amber'
      ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100'
      : 'bg-sky-50 text-sky-900 dark:bg-sky-950/30 dark:text-sky-100';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-zinc-100 bg-zinc-50/60 p-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      {loading ? (
        <p className="px-1 py-2 text-xs text-zinc-400">Loading conversation…</p>
      ) : error ? (
        <p className="px-1 py-2 text-xs text-zinc-400">{error}</p>
      ) : entries.length === 0 ? (
        <p className="px-1 py-2 text-xs text-zinc-400">No earlier messages in this conversation.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((e) => {
            const out = e.direction === 'outbound';
            return (
              <li key={e.id} className={`flex flex-col ${out ? 'items-end' : 'items-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed ${
                    out ? outboundTone : 'bg-white text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                  } border border-zinc-200/70 dark:border-zinc-800`}
                >
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="font-medium">{e.who}</span>
                    <span className="text-[10px] text-zinc-400">{when(e.at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{e.body}</p>
                </div>
              </li>
            );
          })}
          <div ref={endRef} />
        </ol>
      )}
    </div>
  );
}
