'use client';

import { useCardFlip } from './CardFlipContext';

/**
 * Small clock icon shown on the currently-selected Inbox/Texts row. Tapping it
 * flips the left column to the conversation thread (and back). Stops
 * propagation so it doesn't trigger the row's own select/close.
 */
export function HistoryToggleButton({ accent }: { accent: 'amber' | 'sky' }) {
  const { historyOpen, toggleHistory } = useCardFlip();
  const tone =
    accent === 'amber'
      ? 'text-amber-600 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40'
      : 'text-sky-600 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-900/40';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleHistory();
      }}
      aria-label={historyOpen ? 'Hide conversation history' : 'Show conversation history'}
      aria-pressed={historyOpen}
      title={historyOpen ? 'Hide conversation' : 'Show conversation'}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${tone} ${
        historyOpen ? 'bg-black/5 dark:bg-white/10' : ''
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </svg>
    </button>
  );
}
