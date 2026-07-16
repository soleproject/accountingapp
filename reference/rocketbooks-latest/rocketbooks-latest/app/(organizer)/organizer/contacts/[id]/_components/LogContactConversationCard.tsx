'use client';

import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  contactId: string;
  contactName: string;
}

export function LogContactConversationCard({ contactId, contactName }: Props) {
  const { seedPrompt, requestSidecarOpen } = useAssistant();

  const start = () => {
    // Same context-first pattern as the dashboard's LogConversationCard:
    // tell the AI to load recent activity before asking the user what
    // came up, so the conversation starts informed.
    const opener = `I just had a conversation with ${contactName} (contactId: ${contactId}). First, call get_contact_context to load my recent activity with them. Then summarize what stands out in ONE short sentence, and ask me what came up so we can capture notes, follow-up tasks, emails to send, and calendar items — all linked to this contact.`;
    requestSidecarOpen('side');
    seedPrompt(opener, { mode: 'side' });
  };

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/50 p-5 dark:border-violet-900/50 dark:bg-violet-950/20">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
        Log a conversation about {contactName}
      </h2>
      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
        Just spoke with them? Tell the AI — it&apos;ll save notes, create tasks, draft emails, and put follow-ups on your calendar, all linked to this contact.
      </p>
      <button
        type="button"
        onClick={start}
        className="mt-4 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
      >
        Start with AI
      </button>
    </section>
  );
}
