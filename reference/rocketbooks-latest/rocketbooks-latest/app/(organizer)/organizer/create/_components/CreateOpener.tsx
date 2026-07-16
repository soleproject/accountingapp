'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  /** The user's first name, for a personal greeting. */
  firstName: string;
  /** True when reopening a saved document — greet "welcome back" instead of
   *  "what shall we create". */
  hasDraft?: boolean;
}

// Style nudges so the greeting isn't the same line every visit. One is picked
// at random when the workspace opens and folded into the (hidden) seed, which
// pushes the model off its default phrasing even at low temperature.
const VIBES = [
  'warm and concise',
  'upbeat and energetic',
  'friendly and direct',
  'playful but professional',
  'calm and welcoming',
  'enthusiastic and can-do',
];

/**
 * Fires once when the Create workspace mounts: opens the sidecar and seeds a
 * HIDDEN instruction telling the assistant to greet the user BY NAME and ask
 * what they want to create — varying the wording each time. Mirrors
 * WorkspaceOpener but for the task-less "create anything" surface.
 */
export function CreateOpener({ firstName, hasDraft = false }: Props) {
  const { requestSidecarOpen, seedPrompt } = useAssistant();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const vibe = VIBES[Math.floor(Math.random() * VIBES.length)];
    const name = firstName.trim() || 'there';

    const opener = hasDraft
      ? `The user (${name}) just reopened a saved document in the Create workspace — it's already on the canvas (in your page state as current_draft). ` +
        `In ONE short, ${vibe} sentence, greet ${name} BY NAME, note that their saved document is here, and ask whether they'd like to refine it or start something new. ` +
        `VARY your wording. Do NOT regenerate it unless they ask. ` +
        `Keep verbs honest — you draft/write/create; you do not send or file.`
      : `The user (${name}) just opened the Create workspace — a blank canvas for producing a document: a letter, email, text message, resolution, a slide deck, or anything else they need. ` +
        `In ONE short, ${vibe} sentence, greet ${name} BY NAME and ask what they'd like to create right now. ` +
        `Crucial: VARY your wording — do NOT reuse a stock opener; phrase it fresh this time. ` +
        `Once they tell you, ask for any details you need, then call generate_artifact to draft it onto the canvas. ` +
        `Keep verbs honest — you draft/write/create; you do not send or file.`;

    requestSidecarOpen('side');
    seedPrompt(opener, { mode: 'side', hidden: true });
  }, [firstName, hasDraft, requestSidecarOpen, seedPrompt]);

  return null;
}
