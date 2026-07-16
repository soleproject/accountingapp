'use client';

import { useTransition } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Client wrapper for a single-click server action button that also notifies the
 * floating assistant when the action succeeds — so the AI can react in-flow
 * (e.g. "W-9 requests are out — I'll watch for the forms to come back").
 *
 * Pass a `'use server'` action directly (server actions are prop-safe); a
 * no-arg action or one with an OPTIONAL FormData param both satisfy the type.
 */
export function NotifyActionButton({
  action,
  message,
  className,
  title,
  pendingLabel = 'Working…',
  children,
}: {
  action: () => Promise<void>;
  message: string;
  className?: string;
  title?: string;
  pendingLabel?: string;
  children: React.ReactNode;
}) {
  const { notifyAssistant } = useAssistant();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      title={title}
      className={className}
      onClick={() =>
        start(async () => {
          try {
            await action();
            notifyAssistant(message);
          } catch {
            // The action handles its own errors / revalidation; a failed
            // notify should never surface as a thrown render error.
          }
        })
      }
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
