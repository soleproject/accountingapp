'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { SummaryPanel, Transcript, type Segment, type Draft, type ApproveState } from './RecorderShared';

interface Props {
  recordingId: string;
  title: string | null;
  status: string;
  source: string;
  createdAt: string;
  failureReason: string | null;
  initialDraft: Draft | null;
  segments: Segment[];
  canApprove: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  mic: 'Microphone',
  tab: 'Tab audio',
  'mic+tab': 'Mic + tab',
  zoom_bot: 'Zoom (notetaker)',
  teams_bot: 'Teams (notetaker)',
  meet_bot: 'Google Meet (notetaker)',
};

export function RecordingDetail({
  recordingId,
  title,
  status,
  source,
  createdAt,
  failureReason,
  initialDraft,
  segments,
  canApprove,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(initialDraft);
  const [checked, setChecked] = useState<boolean[]>((initialDraft?.actionItems ?? []).map(() => true));
  const [approve, setApprove] = useState<ApproveState>('idle');
  const [approveError, setApproveError] = useState<string | null>(null);

  const approveDraft = useCallback(async () => {
    if (!draft) return;
    const items = draft.actionItems.filter((_, i) => checked[i]);
    setApprove('saving');
    setApproveError(null);
    try {
      const res = await fetch(`/api/recorder/${recordingId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summaryMd: draft.summaryMd,
          actionItems: items.map((it) => ({ text: it.text, dueHint: it.dueHint })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || !json.ok) throw new Error(json.detail ?? json.error ?? `approve ${res.status}`);
      setApprove('saved');
    } catch (err) {
      setApprove('error');
      setApproveError((err as Error).message);
    }
  }, [recordingId, draft, checked]);

  const updateActionItem = useCallback((i: number, text: string) => {
    setDraft((d) => (d ? { ...d, actionItems: d.actionItems.map((it, idx) => (idx === i ? { ...it, text } : it)) } : d));
  }, []);
  const updateSummary = useCallback((text: string) => {
    setDraft((d) => (d ? { ...d, summaryMd: text } : d));
  }, []);
  const toggleChecked = useCallback((i: number) => {
    setChecked((arr) => arr.map((v, idx) => (idx === i ? !v : v)));
  }, []);

  const sourceLabel = SOURCE_LABEL[source] ?? source;
  const pending = status === 'scheduled' || status === 'in_call' || status === 'transcribing' || status === 'uploading';

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/organizer/recorder"
          className="text-sm text-sky-700 hover:underline dark:text-sky-400"
        >
          ← Back to Recorder
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{title ?? 'Untitled'}</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {sourceLabel} · {new Date(createdAt).toLocaleString()} · {status}
        </p>
      </div>

      {status === 'failed' && (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300">
          This recording failed{failureReason ? `: ${failureReason}` : '.'}
        </p>
      )}

      {pending && (
        <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          {status === 'scheduled' && 'Notetaker dispatched — waiting for the meeting to start.'}
          {status === 'in_call' && 'Notetaker is in the meeting, recording now.'}
          {(status === 'transcribing' || status === 'uploading') && 'Transcribing… the summary and tasks will appear shortly.'}
        </p>
      )}

      {draft && (
        <SummaryPanel
          draft={draft}
          checked={checked}
          approve={approve}
          approveError={approveError}
          canApprove={canApprove}
          onSummaryChange={updateSummary}
          onActionItemChange={updateActionItem}
          onToggle={toggleChecked}
          onApprove={approveDraft}
        />
      )}

      {!draft && status === 'ready' && (
        <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          No summary was generated for this recording.
        </p>
      )}

      {segments.length > 0 && <Transcript segments={segments} />}
    </div>
  );
}
