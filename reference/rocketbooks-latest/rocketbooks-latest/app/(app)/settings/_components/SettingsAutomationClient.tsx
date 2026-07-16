'use client';

import { useEffect, useState } from 'react';
import { settingsToLevel, DEFAULT_AUTO_POST_THRESHOLD } from '@/lib/accounting/automation-levels';
import { AiAutomationCard } from './AiAutomationCard';
import { MonthlyReportCard } from './MonthlyReportCard';
import { ReviewAutoOutreachCard } from './ReviewAutoOutreachCard';
import { ContactInquiryCard } from './ContactInquiryCard';
import { SubstantiationCard } from './SubstantiationCard';
import { PayerTinCard } from './PayerTinCard';

type Payload = {
  canManageAutomation: boolean;
  inboundReady: boolean;
  org: {
    aiAutoPostEnabled: boolean | null;
    aiAutoPostThreshold: string | null;
    monthlyReportEnabled: boolean | null;
    monthlyReportRecipients: string | null;
    reviewAutoOutreachEnabled: boolean | null;
    contactInquiryEnabled: boolean | null;
    substantiationEnabled: boolean | null;
    payerTin: string | null;
  } | null;
};

export function SettingsAutomationClient() {
  const [payload, setPayload] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/automation', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Payload | null) => {
        if (!cancelled) setPayload(data);
      })
      .catch(() => {
        if (!cancelled) setPayload({ canManageAutomation: false, inboundReady: false, org: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!payload) {
    return <div className="h-12 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" aria-label="Loading automation settings" />;
  }
  if (!payload.canManageAutomation || !payload.org) return null;

  const org = payload.org;
  const threshold = typeof org.aiAutoPostThreshold === 'number' ? org.aiAutoPostThreshold : Number(org.aiAutoPostThreshold ?? DEFAULT_AUTO_POST_THRESHOLD);
  const automationLevel = settingsToLevel(org.aiAutoPostEnabled ?? true, Number.isFinite(threshold) ? threshold : DEFAULT_AUTO_POST_THRESHOLD);

  return (
    <>
      <AiAutomationCard level={automationLevel} />
      <MonthlyReportCard enabled={org.monthlyReportEnabled ?? false} recipients={org.monthlyReportRecipients ?? ''} />
      <ReviewAutoOutreachCard enabled={org.reviewAutoOutreachEnabled ?? false} />
      <ContactInquiryCard enabled={org.contactInquiryEnabled ?? false} inboundReady={payload.inboundReady} />
      <SubstantiationCard enabled={org.substantiationEnabled ?? false} inboundReady={payload.inboundReady} />
      <PayerTinCard initial={org.payerTin ?? null} />
    </>
  );
}
