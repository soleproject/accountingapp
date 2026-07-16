'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Registers the Enterprise (firm) surface for the global AI sidecar — mounted once
 * in the enterprise layout so the assistant becomes the firm's "staff accountant"
 * on every /enterprise page. pageId 'enterprise' drives the ENTERPRISE persona
 * block in the chat route's system prompt; per-page data + tools land in later
 * phases. Same mechanism as the accounting section's AssistantPageRegistration.
 */
export function EnterpriseAssistantRegistrar() {
  const { setPageContext } = useAssistant();
  const pathname = usePathname() ?? '/enterprise';

  useEffect(() => {
    // The onboarding wizard registers its own step-aware context
    // (EnterpriseOnboardingWalkthrough) — don't stomp it with the generic one.
    if (pathname.startsWith('/enterprise/onboarding')) return;
    setPageContext({
      pageId: 'enterprise',
      pageTitle: 'Firm workspace',
      route: pathname,
      data: {},
      toolNames: undefined,
    });
    return () => setPageContext(null);
  }, [setPageContext, pathname]);

  return null;
}
