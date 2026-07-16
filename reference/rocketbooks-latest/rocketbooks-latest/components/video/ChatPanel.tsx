'use client';

import { useEffect, useRef, useState } from 'react';

/** One rendered chat line. `mine` flips alignment + labels it "You". */
export interface ChatLine {
  id: string;
  name: string;
  text: string;
  mine: boolean;
}

/**
 * Presentational chat sidebar shown next to the prebuilt call frame. Pure UI —
 * it knows nothing about Daily; the parent (VideoCallFrame) owns send/receive
 * and the open/close + expand controls (in the bottom bar). Dark navy to match
 * Daily's tray / our control bar.
 */
export function ChatPanel({
  messages,
  onSend,
  onClose,
  disabled,
}: {
  messages: ChatLine[];
  onSend: (text: string) => void;
  onClose?: () => void;
  /** Chat turned off by the host — show a notice instead of the input. */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft('');
  };

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-white/10 bg-[#121a24] text-white">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-medium text-white">Chat</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            title="Close chat"
            className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <p className="text-xs text-white/40">No messages yet.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.mine ? 'text-right' : 'text-left'}>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                {m.mine ? 'You' : m.name}
              </div>
              <div
                className={`mt-0.5 inline-block max-w-[90%] whitespace-pre-wrap break-words rounded-lg px-2 py-1 text-left text-sm ${
                  m.mine ? 'bg-sky-600 text-white' : 'bg-white/10 text-white'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {disabled ? (
        <div className="border-t border-white/10 p-3 text-center text-xs text-white/50">
          Chat is turned off.
        </div>
      ) : (
        <div className="flex gap-2 border-t border-white/10 p-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            placeholder="Message…"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white placeholder-white/40 focus:border-white/30 focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            className="shrink-0 rounded-md bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-700"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
