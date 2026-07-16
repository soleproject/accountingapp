'use client';

import type { ActionCard } from '@/lib/server/action-cards';

interface TaskCardProps {
  card: ActionCard;
  onAction: () => void;
  onDismiss?: () => void;
  disabled?: boolean;
}

export function TaskCard({ card, onAction, onDismiss, disabled = false }: TaskCardProps) {
  // Blocking tier gets a subtle indigo left accent — visually distinct without
  // alarming. No red badges, no severity gradient (user explicitly called the
  // panel "calm, not a notification center"). Normal tier keeps a transparent
  // accent so card heights stay aligned.
  const accentClass =
    card.tier === 'blocking'
      ? 'border-l-4 border-l-indigo-500'
      : 'border-l-4 border-l-transparent';

  return (
    <div className={`relative ${accentClass} rounded-md border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950`}>
      {card.dismissible && onDismiss && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label={`Dismiss ${card.title}`}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
      <button
        type="button"
        onClick={onAction}
        disabled={disabled}
        className="flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent dark:hover:bg-zinc-900"
      >
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {card.title}
        </div>
        {card.body && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{card.body}</div>
        )}
        <div className="mt-1 text-xs font-medium text-indigo-600 dark:text-indigo-400">
          {card.actionLabel} →
        </div>
      </button>
    </div>
  );
}
