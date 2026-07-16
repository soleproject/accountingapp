'use client';

import { useEffect, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { OnboardingPanel, type OnboardingStatusView } from './OnboardingPanel';

export function GuidedOnboardingClient() {
  const {
    setChatChannel,
    registerOnboardingToolResultHandler,
    requestSidecarOpen,
  } = useAssistant();
  const [status, setStatus] = useState<OnboardingStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setChatChannel('onboarding');
    const unsubscribe = registerOnboardingToolResultHandler((view) => {
      if (typeof view.phase === 'string') setStatus(view as unknown as OnboardingStatusView);
    });
    requestSidecarOpen('side');
    return () => {
      unsubscribe();
      setChatChannel('default');
    };
  }, [setChatChannel, registerOnboardingToolResultHandler, requestSidecarOpen]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/realtime/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'get_onboarding_status', args: {} }),
        });
        const data = (await res.json()) as OnboardingStatusView & { error?: string };
        if (!res.ok || data.error || !data.phase) {
          throw new Error(data.error ?? 'Unable to load guided onboarding');
        }
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load guided onboarding');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
        Guided onboarding is still loading. Refresh if this persists. {error}
      </div>
    );
  }

  if (!status) {
    return <div className="h-48 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" aria-label="Loading guided onboarding" />;
  }

  return <OnboardingPanel status={status} onChanged={setStatus} />;
}
