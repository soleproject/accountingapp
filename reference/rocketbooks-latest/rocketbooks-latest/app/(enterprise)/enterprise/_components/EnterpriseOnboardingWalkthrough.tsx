'use client';

import { useEffect, useRef } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

const PHASE_LABELS: Record<string, string> = {
  private_label: 'Private label',
  branding: 'Branding',
  web_address: 'Web address',
  client_interaction: 'Client Interaction',
  review: 'Review',
  complete: 'Done',
};

/**
 * Makes the AI sidecar step-aware on the "Set up your firm" wizard, mirroring the
 * accounting onboarding: it registers pageId='enterprise-onboarding' with the
 * CURRENT phase so the chat route's FIRM SETUP WALKTHROUGH block coaches only that
 * step, and re-seeds a coaching prompt each time the phase advances (via Continue
 * or the assistant's advance_onboarding_step tool → page reload → new phase).
 */
export function EnterpriseOnboardingWalkthrough({
  phase,
  privateLabelEnabled,
}: {
  phase: string;
  privateLabelEnabled: boolean;
}) {
  const { setPageContext, seedPrompt } = useAssistant();
  const phaseLabel = PHASE_LABELS[phase] ?? phase;
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    setPageContext({
      pageId: 'enterprise-onboarding',
      pageTitle: 'Set up your firm',
      route: '/enterprise/onboarding',
      data: { onboarding: { phase, phaseLabel, privateLabelEnabled } },
      toolNames: ['advance_onboarding_step'],
    });
    return () => setPageContext(null);
  }, [setPageContext, phase, phaseLabel, privateLabelEnabled]);

  // Coach the current step once per phase — re-fires when the phase advances.
  useEffect(() => {
    if (phase === 'complete') return;
    if (seededRef.current === phase) return;
    seededRef.current = phase;
    seedPrompt(
      `The firm is now on the "${phaseLabel}" step of firm setup — you are ALREADY on it, so do NOT call advance_onboarding_step yet. Just coach THIS step: one or two short lines explaining it (per the FIRM SETUP WALKTHROUGH rules) and its single question. Wait for the user's answer before advancing.`,
      { mode: 'bar', hidden: true },
    );
  }, [phase, phaseLabel, seedPrompt]);

  return null;
}
