'use client';

import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Kicks off the AI "client review" walkthrough — the firm assistant goes through
 * the clients that need attention ONE AT A TIME (worst-first), offering to open
 * each client's books (where the in-books assistant does the actual work) or skip.
 * Mirrors the transactions StartGuidedReviewButton: seeds a hidden prompt that the
 * CLIENT REVIEW block in the chat route's system prompt drives.
 */
export function StartClientReviewButton() {
  const { seedPrompt } = useAssistant();

  const onClick = () => {
    seedPrompt(
      `The user wants to go through their clients that need attention, one at a time. Start CLIENT REVIEW now: call list_clients_needing_attention, then focus on the single top-priority client — in one or two short lines say what THAT client needs and offer to open their books, ending the message with EXACTLY [[suggestions: Open <client>'s books | Skip to next | Stop]] (use the client's real name). Follow the CLIENT REVIEW rules in your system prompt (one client at a time).`,
      { mode: 'bar', hidden: true },
    );
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="rs-rainbow-border inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition hover:shadow-md dark:text-zinc-200"
    >
      <span aria-hidden>✨</span> Review clients with AI
    </button>
  );
}
