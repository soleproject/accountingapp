'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RelaunchWelcomeButton } from './RelaunchWelcomeButton';
import { AiContextWindowCard } from './AiContextWindowCard';
import { AiVoiceDocCard } from './AiVoiceDocCard';
import { AiMemoryCard, type AiClientProfileView } from './AiMemoryCard';
import { EmailSignatureCard } from './EmailSignatureCard';
import { MeetingFollowupsCard } from './MeetingFollowupsCard';
import { VideoTranscriptionCard } from './VideoTranscriptionCard';
import { WeeklyDigestCard } from './WeeklyDigestCard';
import { SettingsAutomationClient } from './SettingsAutomationClient';

type Payload = {
  user: { id: string; email: string | null };
  profile: {
    fullName: string | null;
    role: string | null;
    aiThreadContextWindow: number | null;
    aiVoiceDoc: string | null;
    emailSignature: string | null;
    weeklyDigestOptInAt: string | null;
  } | null;
  orgId: string;
  org: {
    name: string | null;
    planType: string | null;
    accountingMethod: string | null;
    processingMode: string | null;
    onboardingMode: string | null;
    entityType: string | null;
    domain: string | null;
    aiClientProfile: AiClientProfileView | null;
    meetingFollowupsEnabled: boolean | null;
    meetingFollowupsGraceMinutes: number | null;
    videoTranscriptionEnabled: boolean | null;
  } | null;
};

export function SettingsClient() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/summary', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`status ${res.status}`))))
      .then((data: Payload) => {
        if (!cancelled) setPayload(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-amber-600">Settings are still loading. Refresh if this persists.</p>;
  if (!payload) return <SettingsBodySkeleton />;

  const { user, profile, org, orgId } = payload;

  return (
    <>
      <Card title="Profile">
        <Field label="Email" value={user.email ?? '—'} />
        <Field label="Name" value={profile?.fullName ?? '—'} />
        <Field label="Role" value={profile?.role ?? '—'} />
        <Field label="User ID" value={user.id} mono />
      </Card>

      <SettingsAutomationClient />

      <AiContextWindowCard initial={profile?.aiThreadContextWindow ?? null} />
      <AiMemoryCard profile={(org?.aiClientProfile as AiClientProfileView | null) ?? {}} />
      <AiVoiceDocCard initial={profile?.aiVoiceDoc ?? null} />
      <EmailSignatureCard initial={profile?.emailSignature ?? null} />
      <MeetingFollowupsCard enabled={org?.meetingFollowupsEnabled ?? false} graceMinutes={org?.meetingFollowupsGraceMinutes ?? 30} />
      <VideoTranscriptionCard enabled={org?.videoTranscriptionEnabled ?? false} />
      <WeeklyDigestCard enabled={!!profile?.weeklyDigestOptInAt} />

      <Card title="Booking links">
        <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
          <div className="text-zinc-600 dark:text-zinc-400">
            Share a link so people can book a time on your calendar based on your availability.
          </div>
          <Link
            href="/organizer/settings/booking"
            className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Manage booking links
          </Link>
        </div>
      </Card>

      <Card title="Organization">
        <Field label="Name" value={org?.name ?? '—'} />
        <Field label="Plan" value={org?.planType ?? '—'} />
        <Field label="Accounting method" value={org?.accountingMethod ?? '—'} />
        <Field label="Processing mode" value={org?.processingMode ?? '—'} />
        <Field label="Onboarding mode" value={org?.onboardingMode ?? '—'} />
        <Field label="Entity type" value={org?.entityType ?? '—'} />
        <Field label="Domain" value={org?.domain ?? '—'} />
        <Field label="Org ID" value={orgId} mono />
      </Card>

      <Card title="Walkthrough">
        <div className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
          <div className="text-zinc-600 dark:text-zinc-400">
            Re-run the initial welcome experience -- the greeting, the chip options, and the cool-tour / regular tour flows.
          </div>
          <RelaunchWelcomeButton />
        </div>
      </Card>
    </>
  );
}

function SettingsBodySkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
      ))}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{title}</h2>
      </header>
      <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">{children}</dl>
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-3 px-4 py-2 text-sm">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={`col-span-2 text-zinc-700 dark:text-zinc-300 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
