'use client';

import { useEffect } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  windowDays: number;
  withExtrapolation: boolean;
  orgName: string;
  kpis: {
    totalRevenue: number;
    totalExpenses: number;
    netPL: number;
    totalAr: number;
    totalAp: number;
    cashNow: number;
    projectedCashAtForwardEnd: number;
  };
}

/**
 * Registers the Pulse page with the assistant so chat turns include the user's
 * current window and headline numbers in the system prompt. Lets a "walk me
 * through" or "explain this" prompt reference the actual figures on screen
 * instead of the AI re-fetching everything.
 */
export function PulseRegistration({ windowDays, withExtrapolation, orgName, kpis }: Props) {
  const { setPageContext } = useAssistant();
  useEffect(() => {
    setPageContext({
      pageId: 'pulse',
      pageTitle: 'Pulse',
      route: `/pulse?days=${windowDays}${withExtrapolation ? '&ext=1' : ''}`,
      data: {
        org: orgName,
        windowDays,
        extrapolation: withExtrapolation,
        // Round to whole dollars — the AI doesn't need cents and tokens are
        // worth more than two decimals of precision in this surface.
        revenue_window: Math.round(kpis.totalRevenue),
        expenses_window: Math.round(kpis.totalExpenses),
        net_pl_window: Math.round(kpis.netPL),
        outstanding_ar: Math.round(kpis.totalAr),
        outstanding_ap: Math.round(kpis.totalAp),
        cash_now: Math.round(kpis.cashNow),
        projected_cash_forward: Math.round(kpis.projectedCashAtForwardEnd),
      },
    });
    return () => setPageContext(null);
  }, [setPageContext, windowDays, withExtrapolation, orgName, kpis]);
  return null;
}
