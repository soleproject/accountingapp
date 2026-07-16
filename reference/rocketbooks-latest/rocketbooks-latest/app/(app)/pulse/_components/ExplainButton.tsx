'use client';

import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  /** The prompt seeded into the chat exactly as if the user had typed it. */
  prompt: string;
  /** Short on-screen label. Defaults to "Explain". */
  label?: string;
}

/**
 * Per-card AI affordance. Uses the existing site-wide assistant sidecar — does
 * NOT spawn a new chat surface. Pages that want the AI to talk about a chart
 * pass a fully-formed prompt; the sidecar opens, fills its input, submits as
 * if the user had typed it, and the model has the page's pre-loaded context.
 */
export function ExplainButton({ prompt, label = 'Explain' }: Props) {
  const { seedPrompt } = useAssistant();
  return (
    <button
      type="button"
      onClick={() => seedPrompt(prompt)}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition hover:border-violet-400 hover:bg-violet-50 hover:text-violet-700 dark:border-zinc-800 dark:text-zinc-400 dark:hover:border-violet-700 dark:hover:bg-violet-950 dark:hover:text-violet-300"
      aria-label={`${label} — open assistant`}
    >
      <SparkIcon /> {label}
    </button>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden>
      <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6L8 1z" />
    </svg>
  );
}
