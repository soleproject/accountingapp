'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionCard } from '@/lib/server/action-cards';
import { TaskCard } from '@/components/cards/TaskCard';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

const DISMISS_KEY_PREFIX = 'rs_card_dismissed:';

/**
 * The prioritized action cards on the Tasks page — the same signals as the AI
 * Assistant rail, but as a full-width to-do list. Each card's action routes or
 * opens the floating assistant (seeded with its prompt). Dismissals share the
 * localStorage key with the assistant rail so they stay consistent.
 */
export function AttentionCards({ cards, source = 'tasks' }: { cards: ActionCard[]; source?: string }) {
  const router = useRouter();
  const { seedPrompt, requestSidecarOpen } = useAssistant();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Read persisted dismissals after mount (localStorage is client-only, so this
  // can't be a lazy initializer without an SSR/hydration mismatch). One-shot per
  // card set; never loops.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const next = new Set<string>();
    try {
      for (const c of cards) {
        if (window.localStorage.getItem(DISMISS_KEY_PREFIX + c.id) === '1') next.add(c.id);
      }
    } catch {
      // ignore — show all if localStorage is unavailable
    }
    setDismissed(next);
  }, [cards]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const dismiss = useCallback((id: string) => {
    try {
      window.localStorage.setItem(DISMISS_KEY_PREFIX + id, '1');
    } catch {
      // ignore
    }
    setDismissed((s) => new Set(s).add(id));
  }, []);

  const handle = useCallback(
    (card: ActionCard) => {
      // "Finish setting up …" → open the AI Assistant page with the onboarding
      // wizard at the user's current step (carry from=tasks for the back link).
      if (card.id === 'onboarding') {
        router.push(`/ai-chat?onboarding=start&from=${source}`);
        return;
      }
      switch (card.action.kind) {
        case 'navigate': {
          const href = card.action.href;
          router.push(`${href}${href.includes('?') ? '&' : '?'}from=${source}`);
          break;
        }
        case 'open-categorization-workspace':
          router.push(`/ai-chat?categorize=open&from=${source}`);
          break;
        case 'plaid-relink':
          // The assistant hosts the Plaid relink launcher.
          router.push(`/ai-chat?from=${source}`);
          break;
        case 'ask-ai':
          seedPrompt(card.action.prompt, { mode: 'bar' });
          break;
      }
    },
    [router, seedPrompt, source],
  );

  const visible = cards.filter((c) => !dismissed.has(c.id));
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          requestSidecarOpen('bar');
          seedPrompt('Walk me through everything that needs my attention — one at a time, most important first, and wait for my go-ahead on each.');
        }}
        className="self-start rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
      >
        ✨ Walk me through these
      </button>
      {visible.map((c) => (
        <TaskCard key={c.id} card={c} onAction={() => handle(c)} onDismiss={c.dismissible ? () => dismiss(c.id) : undefined} />
      ))}
    </div>
  );
}
