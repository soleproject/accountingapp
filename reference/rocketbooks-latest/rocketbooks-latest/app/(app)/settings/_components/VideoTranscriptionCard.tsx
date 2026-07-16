'use client';

import { useState, useTransition } from 'react';
import { setVideoTranscriptionAction } from '../_actions/videoTranscription';

/**
 * Org-level toggle for Organizer Video auto-transcription. Optimistic with
 * rollback, matching MeetingFollowupsCard.
 */
export function VideoTranscriptionCard({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const r = await setVideoTranscriptionAction(next);
      if (!r.ok) {
        setError(r.error ?? 'Save failed');
        setOn(!next);
      }
    });
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Video Transcription</h2>
      </header>
      <div className="flex flex-col gap-4 px-4 py-3 text-sm">
        <p className="text-xs text-zinc-500">
          When on, Organizer video calls are transcribed live (speaker-attributed by name), saved to the
          call record, and a copy is emailed to the host when the call ends. Transcription is a paid Daily
          add-on (~$0.0059 per participant-minute, roughly 35¢ for a 30-minute 1:1) — off by default.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Status</span>
          <select
            value={on ? 'on' : 'off'}
            onChange={(e) => {
              const next = e.target.value === 'on';
              setOn(next);
              save(next);
            }}
            disabled={isPending}
            className="max-w-xs rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        {isPending && <div className="text-xs text-zinc-500">Saving…</div>}
      </div>
    </section>
  );
}
