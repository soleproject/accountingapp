'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

interface Props {
  recentMeetings: Array<{ id: string; title: string | null; createdAt: string; status: string }>;
}

type BotSend = 'idle' | 'sending' | 'sent' | 'error';

export function NotetakerWorkspace({ recentMeetings }: Props) {
  return (
    <div className="space-y-6">
      <MeetingBotPanel />
      {recentMeetings.length > 0 && <RecentMeetings rows={recentMeetings} />}
    </div>
  );
}

// Send a Recall.ai bot into a Zoom / Teams / Meet call. The bot joins, records,
// and the webhook feeds the same transcribe → draft → notes pipeline as a mic
// recording. Results show up in "Recent meetings" once the meeting ends and
// Deepgram finishes; this panel just dispatches.
function MeetingBotPanel() {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [send, setSend] = useState<BotSend>('idle');
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback(async () => {
    setSend('sending');
    setError(null);
    try {
      const res = await fetch('/api/recorder/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingUrl: url.trim(),
          title: title.trim() || undefined,
          consentAck: true,
        }),
      });
      const json = (await res.json()) as { recordingId?: string; error?: string; detail?: string };
      if (!res.ok || !json.recordingId) {
        const parts = [json.error, json.detail].filter(Boolean);
        throw new Error(parts.length ? parts.join(' — ') : `dispatch ${res.status}`);
      }
      setSend('sent');
      setUrl('');
      setTitle('');
      setConsent(false);
    } catch (err) {
      setSend('error');
      setError((err as Error).message);
    }
  }, [url, title]);

  const canSend = consent && url.trim().length > 0 && send !== 'sending';

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div>
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Send a notetaker to a meeting</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Paste a Zoom, Microsoft Teams, or Google Meet link. A notetaker bot joins, records, and drafts your
          notes and follow-up tasks when the meeting ends.
        </p>
      </div>

      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://zoom.us/j/… or Teams / Meet link"
        className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      />
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      />

      <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500"
        />
        <span>
          I confirm everyone in this meeting will be notified it is being recorded. The notetaker announces
          itself on joining.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={dispatch}
          disabled={!canSend}
          className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {send === 'sending' ? 'Sending…' : 'Send notetaker'}
        </button>
        {send === 'sent' && (
          <span className="text-sm text-emerald-600 dark:text-emerald-400">
            Notetaker dispatched — it’ll appear in Recent meetings after the meeting.
          </span>
        )}
        {send === 'error' && error && <span className="text-sm text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </div>
  );
}

function RecentMeetings({ rows }: { rows: Props['recentMeetings'] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Recent meetings</h2>
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/organizer/recorder/${r.id}`}
              className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
            >
              <span className="truncate">{r.title ?? 'Untitled'}</span>
              <span className="shrink-0 text-xs text-zinc-500">
                {new Date(r.createdAt).toLocaleString()} · {r.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
