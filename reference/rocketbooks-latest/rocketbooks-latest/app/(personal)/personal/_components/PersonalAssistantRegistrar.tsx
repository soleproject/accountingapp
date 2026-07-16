'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

/**
 * Registers the Personal product's page context for the global AI sidecar.
 * Mounted once in the personal layout so the personal toolset is available on
 * every personal page. pageId 'personal' maps to PERSONAL_TOOLS in the
 * page-tool registry; omitting toolNames exposes all of them.
 *
 * Read-only: every capability below is backed by a real query tool — the
 * assistant can answer about the data but cannot move money or change anything.
 */
export function PersonalAssistantRegistrar() {
  const { setPageContext } = useAssistant();
  const pathname = usePathname() ?? '/personal';

  useEffect(() => {
    setPageContext({
      pageId: 'personal',
      pageTitle: 'Personal Finance',
      route: pathname,
      data: {
        note: "The user's personal finances (separate from business accounting). Answer their money questions by calling the personal tools — they read live data. You can analyze and explain, but you cannot make changes.",
        capabilities: [
          'get_personal_overview — net worth, this-month income/spending, top categories.',
          'get_personal_spending — spending by category for a period (this/last month, 30 days, year).',
          'list_personal_accounts — accounts with balances + net worth.',
          'search_personal_transactions — filter by category/merchant/amount/period.',
          'get_personal_budgets_status — budgets vs spending, what is over.',
        ],
      },
    });
    return () => setPageContext(null);
  }, [setPageContext, pathname]);

  return null;
}
