'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Context-aware "Start guided review" button.
 * - On a review VIEW (reviewKind set) → starts THAT view's guided flow directly
 *   (adds guide=1 to the current URL).
 * - On the main transactions page (reviewKind null) → opens the assistant picker
 *   asking which of the three flows to start (by chip or voice).
 */
export function StartGuidedReviewButton({
  reviewKind,
  deposits,
  aiCategorized,
  uncategorized,
}: {
  reviewKind: 'deposits' | 'ai_categorized' | 'uncategorized' | null;
  deposits: number;
  aiCategorized: number;
  uncategorized: number;
}) {
  const { seedPrompt } = useAssistant();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onClick = () => {
    if (reviewKind) {
      // Start this view's guided flow: same URL + guide=1.
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('guide', '1');
      router.push(`${pathname}?${sp.toString()}`);
      return;
    }
    // Main page → let the assistant pick which review to start.
    const seed =
      `The user clicked "Start guided review" and wants to pick which flow to begin. In ONE short, friendly line, ` +
      `offer the three options with their counts — Review Deposits (${deposits}), Review AI Categorized (${aiCategorized}), ` +
      `and Uncategorized Spending (${uncategorized}) — and ask which they'd like to start. END the message with EXACTLY ` +
      `[[suggestions: Review deposits | Review AI categorized | Review uncategorized]]. ` +
      `When they choose (tap a chip, or tell/say which), call start_guided_review with which='deposits' | 'ai_categorized' | 'uncategorized'. Do nothing else.`;
    seedPrompt(seed, { mode: 'bar', hidden: true });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="rs-rainbow-border inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:shadow-md dark:text-zinc-200"
    >
      <span aria-hidden>✨</span> Start guided review
    </button>
  );
}
