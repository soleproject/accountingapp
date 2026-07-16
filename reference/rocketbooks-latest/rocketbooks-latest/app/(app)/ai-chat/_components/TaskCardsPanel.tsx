'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { TaskCard } from '@/components/cards/TaskCard';
import type { ActionCard } from '@/lib/server/action-cards';

const POLL_INTERVAL_MS = 15_000;
const VISIBLE_LIMIT = 5;
const DISMISS_KEY_PREFIX = 'rs_card_dismissed:';

const EMPTY_DISMISSED_SET: ReadonlySet<string> = new Set();

interface Props {
  initialCards: ActionCard[];
  /**
   * True while a prompt is in flight (ChatBox pending or VoiceMode non-idle).
   * Disables click handlers across all cards so a second tap doesn't queue
   * a duplicate prompt while the AI is still responding.
   */
  busy: boolean;
  /**
   * Card action delegate. The panel doesn't know about voice vs text or about
   * Plaid Link — it just hands the card up. Parent (AiChatWorkspace) routes.
   */
  onAction: (card: ActionCard) => void;
}

// Module-level dismiss store. useSyncExternalStore needs a stable snapshot
// reference between calls when external state hasn't changed; we cache the
// last snapshot and invalidate on writes (or on cross-tab `storage` events).
let cachedDismissed: ReadonlySet<string> | null = null;
const dismissSubscribers = new Set<() => void>();

function readDismissedFromStorage(): ReadonlySet<string> {
  if (typeof window === 'undefined') return EMPTY_DISMISSED_SET;
  const result = new Set<string>();
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(DISMISS_KEY_PREFIX)) {
        result.add(k.slice(DISMISS_KEY_PREFIX.length));
      }
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); treat as empty
  }
  return result;
}

function getDismissedSnapshot(): ReadonlySet<string> {
  if (cachedDismissed === null) cachedDismissed = readDismissedFromStorage();
  return cachedDismissed;
}

function getDismissedServerSnapshot(): ReadonlySet<string> {
  return EMPTY_DISMISSED_SET;
}

function invalidateDismissed(): void {
  cachedDismissed = null;
  for (const cb of dismissSubscribers) cb();
}

function subscribeDismissed(cb: () => void): () => void {
  dismissSubscribers.add(cb);
  // Cross-tab updates: a sibling tab dismissing a card invalidates ours too.
  const onStorage = () => invalidateDismissed();
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    dismissSubscribers.delete(cb);
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export function TaskCardsPanel({ initialCards, busy, onAction }: Props) {
  const [cards, setCards] = useState<ActionCard[]>(initialCards);
  const [loadRequested, setLoadRequested] = useState(initialCards.length > 0);
  const [expanded, setExpanded] = useState(false);
  const dismissed = useSyncExternalStore(
    subscribeDismissed,
    getDismissedSnapshot,
    getDismissedServerSnapshot,
  );

  const fetchCards = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/action-cards', { cache: 'no-store' });
      if (!r.ok) return;
      const data = (await r.json()) as { cards?: ActionCard[] };
      if (Array.isArray(data.cards)) setCards(data.cards);
    } catch {
      // keep showing previous list — no skeleton flicker on transient errors
    }
  }, []);

  // Background poll. Stale-while-revalidate: show the existing list during
  // refetch, only swap on success. Pauses while the tab is hidden so we
  // don't burn quota on backgrounded tabs. When /ai-chat starts with an empty
  // server seed, wait for explicit user intent instead of hitting DB-backed
  // action cards during first paint.
  useEffect(() => {
    if (!loadRequested) return;
    let intervalId: number | null = null;

    const startPolling = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(fetchCards, POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        void fetchCards();
        startPolling();
      }
    };

    if (!document.hidden && initialCards.length > 0) {
      void fetchCards();
      startPolling();
    } else if (!document.hidden) {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchCards, initialCards.length, loadRequested]);

  const handleDismiss = useCallback((id: string) => {
    try {
      window.localStorage.setItem(DISMISS_KEY_PREFIX + id, '1');
    } catch {
      // ignore — render-side filter falls back to "not dismissed"
    }
    invalidateDismissed();
  }, []);

  const visibleAfterDismiss = cards.filter((c) => !dismissed.has(c.id));
  const blockingCards = visibleAfterDismiss.filter((c) => c.tier === 'blocking');
  const overflowCount = Math.max(0, visibleAfterDismiss.length - VISIBLE_LIMIT);
  const renderList = expanded ? visibleAfterDismiss : visibleAfterDismiss.slice(0, VISIBLE_LIMIT);

  return (
    <>
      {/* Desktop / large screens: full vertical rail with overflow disclosure */}
      <div className="hidden flex-col gap-2 lg:flex">
        {visibleAfterDismiss.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-1 py-2 text-sm text-zinc-500 dark:text-zinc-500">
            <span className="italic">All caught up.</span>
            {!loadRequested && (
              <button
                type="button"
                onClick={() => {
                  setLoadRequested(true);
                  void fetchCards();
                }}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs not-italic text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Load suggestions
              </button>
            )}
          </div>
        ) : (
          <>
            {renderList.map((c) => (
              <TaskCard
                key={c.id}
                card={c}
                disabled={busy}
                onAction={() => onAction(c)}
                onDismiss={c.dismissible ? () => handleDismiss(c.id) : undefined}
              />
            ))}
            {overflowCount > 0 && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="self-start px-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Show {overflowCount} more
              </button>
            )}
            {expanded && visibleAfterDismiss.length > VISIBLE_LIMIT && (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="self-start px-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                Show less
              </button>
            )}
          </>
        )}
      </div>

      {/* Mobile/tablet: blocking-tier only, horizontal scrollable strip. If
          there are no blocking cards, render nothing — the user came to chat,
          not to triage routine actions. */}
      {blockingCards.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
          {blockingCards.map((c) => (
            <div key={c.id} className="min-w-[260px] shrink-0">
              <TaskCard
                card={c}
                disabled={busy}
                onAction={() => onAction(c)}
                onDismiss={c.dismissible ? () => handleDismiss(c.id) : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
