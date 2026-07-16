'use client';

import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  /** The company currently selected in the picker, or null for "All companies". */
  company: { id: string; name: string } | null;
}

/**
 * Top-of-dashboard "Log a conversation" pill. Clicking opens the AI sidecar
 * and seeds it. When a company is selected in the picker, the AI loads that
 * contact's recent activity and asks about the conversation with them;
 * otherwise it opens cold and asks the user to describe the meeting.
 */
export function LogConversationPill({ company }: Props) {
  const { seedPrompt, requestSidecarOpen } = useAssistant();

  const start = () => {
    // With a company selected, instruct the AI to load context first (recent
    // notes / tasks / appointments / inbox) so it can open with an informed
    // sentence instead of a cold "what happened?". With no company, the AI
    // still needs to resolve any person the user names mid-conversation —
    // otherwise notes/tasks land unlinked and don't show up on the contact's
    // drill-in page.
    const opener = company
      ? `I just had a conversation with ${company.name} (contactId: ${company.id}). First, call get_contact_context to load my recent activity with them. Then summarize what stands out in ONE short sentence, and ask me what came up so we can capture notes, follow-up tasks, emails to send, and calendar items linked to this contact.`
      : `I just had a conversation I want to log. Help me capture what came out of it — notes, follow-up tasks, emails to send, calendar items. Open by asking me to tell you about the meeting.

IMPORTANT: as soon as I mention a person by name, call lookup_contact to resolve their contactId, then pass that contactId on EVERY create_note / create_task / create_appointment / send_email call so the work is linked to the right contact (otherwise it won't show up on their drill-in page). If lookup_contact returns no match, ask me whether to create the contact (then call create_contact).`;
    requestSidecarOpen('side');
    // `hidden`: send the opener to the model (it triggers + instructs the turn)
    // but don't render it as a user bubble — the user just sees the AI open.
    seedPrompt(opener, { mode: 'side', hidden: true });
  };

  return (
    <button
      type="button"
      onClick={start}
      className="inline-flex items-center gap-1.5 rounded-full border border-violet-200/70 bg-gradient-to-br from-violet-50 to-white px-3.5 py-1.5 text-sm font-medium text-violet-700 shadow-sm transition-shadow hover:shadow-md dark:border-violet-900/40 dark:from-violet-950/30 dark:to-zinc-900 dark:text-violet-300"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
      </svg>
      Log a conversation
    </button>
  );
}
