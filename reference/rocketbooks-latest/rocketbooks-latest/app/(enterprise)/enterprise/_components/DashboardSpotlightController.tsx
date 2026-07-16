'use client';

import { useEffect } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Handles the AI `spotlight_client` client action during client review: switches
 * the dashboard to the Client Businesses tab, scrolls the focused client's row to
 * the top, and gives it a blue glow — so the user sees exactly which client the
 * assistant is talking about. Rows are tagged with data-org-row={orgId} in both
 * the compact table and the monthly-timeline views.
 */
export function DashboardSpotlightController() {
  const { registerClientAction } = useAssistant();

  useEffect(() => {
    const off = registerClientAction('spotlight_client', (args) => {
      const orgId = String((args as { orgId?: unknown }).orgId ?? '');
      if (!orgId || typeof window === 'undefined') return;
      // Switch to the Client Businesses tab first.
      window.dispatchEvent(
        new CustomEvent('rs-dashboard-select-tab', { detail: { label: 'Client Businesses' } }),
      );
      // Once the tab has rendered, scroll the row to the top + glow it.
      window.setTimeout(() => {
        const row = document.querySelector(`[data-org-row="${orgId}"]`);
        if (row instanceof HTMLElement) {
          // Add the class BEFORE scrolling so its scroll-margin-top offset applies.
          row.classList.remove('rs-spotlight');
          // reflow so the animation restarts if the same row is spotlighted twice
          void row.offsetWidth;
          row.classList.add('rs-spotlight');
          row.scrollIntoView({ behavior: 'smooth', block: 'start' });
          window.setTimeout(() => row.classList.remove('rs-spotlight'), 4500);
        }
      }, 260);
    });
    return () => off();
  }, [registerClientAction]);

  return null;
}
