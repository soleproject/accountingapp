'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

const LABEL: Record<string, string> = {
  deposits: 'deposits',
  ai_categorized: 'AI-categorized transactions',
  uncategorized: 'uncategorized spending',
};

/**
 * Rendered when the user lands on a review VIEW (deposits / AI-categorized /
 * uncategorized) but has NOT started the guided walk-through. Seeds the assistant
 * once to OFFER the review — the user starts it by tapping "Start review" (which
 * the sidecar intercepts → navigates to guide=1) or the page's Start-guided-review
 * button. Renders nothing itself.
 */
export function ReviewStartAsk({
  reviewKind,
  count,
}: {
  reviewKind: 'deposits' | 'ai_categorized' | 'uncategorized';
  count: number;
}) {
  const { seedPrompt } = useAssistant();
  const askedRef = useRef<string | null>(null);

  useEffect(() => {
    // Offer once per review-kind landing (not on every count change / re-render).
    if (askedRef.current === reviewKind) return;
    askedRef.current = reviewKind;
    const label = LABEL[reviewKind] ?? 'transactions';
    seedPrompt(
      `The user just opened the ${label} review view — ${count} to review — but has NOT started the guided walk-through yet. ` +
        `In ONE short, friendly line, offer to walk them through ${count === 1 ? 'it' : 'them'} one at a time, and END with [[suggestions: Start review | Not now]]. ` +
        `Do NOT start or call any tools yet — tapping "Start review" navigates them into the guided flow. If they tap "Not now", acknowledge in a few words and stop.`,
      { mode: 'bar', hidden: true },
    );
  }, [reviewKind, count, seedPrompt]);

  return null;
}
