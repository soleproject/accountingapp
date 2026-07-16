'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import type { ParticipantEvent, PersistableChat, TranscriptLine } from './VideoCallFrame';

const VideoCallFrame = dynamic(
  () => import('./VideoCallFrame').then((mod) => mod.VideoCallFrame),
  {
    ssr: false,
    loading: () => <div className="flex h-full items-center justify-center text-sm text-zinc-300">Loading video room…</div>,
  },
);

/**
 * Orchestrates a 1:1 video call from the Organizer:
 *   "Start a call" → POST /api/video/rooms → mount the prebuilt frame.
 *   Leave         → PATCH /api/video/sessions/:id (sets ended_at) → back to idle.
 *
 * All Daily specifics live behind the server route + <VideoCallFrame>; this
 * component only speaks our own API. The join-link / guest flow lands in Phase 3.
 */

interface ActiveCall {
  sessionId: string | null;
  roomName: string;
  roomUrl: string;
  token: string;
}

type Status = 'idle' | 'creating' | 'in-call' | 'error';

export function VideoRoomLauncher({
  configured,
  transcription = false,
}: {
  configured: boolean;
  /** Org has auto-transcription enabled — start it + persist + email on end. */
  transcription?: boolean;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [copied, setCopied] = useState(false);

  // Live origin, so the invite link works in any env. Lazy-read (not via an
  // effect) — safe from hydration mismatch because the link only renders once a
  // call is active (a post-mount, client-only state), never in the SSR tree.
  const [origin] = useState(() => (typeof window !== 'undefined' ? window.location.origin : ''));

  const inviteUrl = call && origin ? `${origin}/video/join/${call.roomName}` : '';

  const copyInvite = useCallback(async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — the field is selectable as a fallback
    }
  }, [inviteUrl]);

  const startCall = useCallback(async () => {
    setStatus('creating');
    setError(null);
    try {
      const res = await fetch('/api/video/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Could not start the call (${res.status})`);
      }
      const data = (await res.json()) as ActiveCall;
      setCall(data);
      setStatus('in-call');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the call');
      setStatus('error');
    }
  }, []);

  // Best-effort: mark the session ended. A failure here must not trap the user
  // in the call UI, so we reset regardless.
  const endSession = useCallback(async (sessionId: string | null) => {
    if (sessionId) {
      try {
        await fetch(`/api/video/sessions/${sessionId}`, { method: 'PATCH' });
      } catch {
        // swallow — the room expires on its own; this is just history bookkeeping
      }
    }
  }, []);

  // Persist join/leave to the session record. Fire-and-forget: capturing the
  // record must never disrupt a live call, so failures are swallowed. Stable
  // for the call's lifetime (call.sessionId doesn't change mid-call), so it
  // won't tear down the frame.
  const handleParticipant = useCallback(
    (evt: ParticipantEvent) => {
      const sessionId = call?.sessionId;
      if (!sessionId) return;
      void fetch(`/api/video/sessions/${sessionId}/participants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
      }).catch(() => {});
    },
    [call],
  );

  // Persist chat. The host saves its own sends + the guest's received messages,
  // so the whole conversation lands in the record. Fire-and-forget. Stable for
  // the call's lifetime so it won't tear down the frame.
  const handlePersistMessage = useCallback(
    (msg: PersistableChat) => {
      const sessionId = call?.sessionId;
      if (!sessionId) return;
      void fetch(`/api/video/sessions/${sessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      }).catch(() => {});
    },
    [call],
  );

  // Persist transcript lines (host only). Fire-and-forget, same model as chat.
  const handleTranscriptLine = useCallback(
    (line: TranscriptLine) => {
      const sessionId = call?.sessionId;
      if (!sessionId) return;
      void fetch(`/api/video/sessions/${sessionId}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(line),
      }).catch(() => {});
    },
    [call],
  );

  const handleLeft = useCallback(() => {
    const sessionId = call?.sessionId ?? null;
    setStatus('idle');
    setCall(null);
    void endSession(sessionId);
  }, [call, endSession]);

  const handleError = useCallback(
    (message: string) => {
      const sessionId = call?.sessionId ?? null;
      setError(message);
      setStatus('error');
      setCall(null);
      void endSession(sessionId);
    },
    [call, endSession],
  );

  if (status === 'in-call' && call) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="shrink-0 text-zinc-500 dark:text-zinc-400">Invite link</span>
          <input
            readOnly
            value={inviteUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          />
          <button
            type="button"
            onClick={copyInvite}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div className="h-[70vh] min-h-[480px] overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 dark:border-zinc-800">
          <VideoCallFrame
            roomUrl={call.roomUrl}
            token={call.token}
            onLeft={handleLeft}
            onError={handleError}
            onParticipant={handleParticipant}
            chat
            onPersistMessage={handlePersistMessage}
            isHost
            onTranscriptLine={transcription ? handleTranscriptLine : undefined}
            autoTranscribe={transcription}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">Start a video call</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Spin up a private, one-on-one room with screen sharing. The room is
        short-lived and only people with the link and a join token can enter.
      </p>

      {!configured && (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Video calling isn’t configured yet. Set <code>DAILY_API_KEY</code> to enable it.
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="mt-5">
        <button
          type="button"
          onClick={startCall}
          disabled={!configured || status === 'creating'}
          className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'creating' ? 'Starting…' : 'Start a call'}
        </button>
      </div>
    </div>
  );
}
