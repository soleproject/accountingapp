'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  taskTitle: string;
  /** True when a saved draft was loaded — changes the greeting from
   *  "want me to draft this?" to "want to refine the existing draft?". */
  hasDraft: boolean;
}

/**
 * Fires once when the workspace mounts: opens the sidecar in side mode and
 * seeds a HIDDEN instruction telling the assistant to greet, infer which kind
 * of artifact this task needs from the linked context already in its page
 * state, and CONFIRM before drafting. The seed is hidden so the user sees the
 * assistant's greeting, not the operational wall of text.
 *
 * Mirrors the seed discipline of the task-row AI button: do NOT generate yet —
 * wait for the user's yes.
 */
export function WorkspaceOpener({ taskTitle, hasDraft }: Props) {
  const { requestSidecarOpen, seedPrompt } = useAssistant();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const opener = hasDraft
      ? `The user just reopened the Task Workspace for the task "${taskTitle}". ` +
        `There is ALREADY a saved draft on the canvas (it's in your page state as current_draft). ` +
        `Do NOT regenerate it. In ONE short, friendly message, acknowledge the existing draft and ask whether they'd like to refine it or if it's good as-is. ` +
        `End that message with this exact marker on its own final line: [[suggestions: Refine it | It's good]] ` +
        `Only call generate_artifact if they ask for a change — and then return the FULL revised body. ` +
        `Keep verbs honest — you draft/write/create; you do not send or file.`
      : `The user just opened the Task Workspace for the task "${taskTitle}". ` +
        `Your job here is to help them produce an artifact (a letter, email, text message, or resolution) on the open canvas. ` +
        `Use the linked context in your page state — the linked contact(s), recent notes, related emails/texts, and meetings — to understand what's needed. ` +
        `Do NOT call generate_artifact yet. First, in ONE short, friendly message: ` +
        `(1) infer the single most likely artifact kind from the task and its context (e.g. an overdue-invoice task → a follow-up email; an engagement task → a letter), ` +
        `(2) say what you'd draft in one sentence referencing a concrete detail from the context if you have one, and ` +
        `(3) ask the user to confirm or tell you to change it. ` +
        `End that message with this exact marker on its own final line: [[suggestions: Yes, draft it | Change something]] ` +
        `Only after they confirm, call generate_artifact with kind + a clear title + the full body. ` +
        `Keep verbs honest — you draft/write/create; you do not send or file.`;

    requestSidecarOpen('side');
    seedPrompt(opener, { mode: 'side', hidden: true });
  }, [taskTitle, hasDraft, requestSidecarOpen, seedPrompt]);

  return null;
}
