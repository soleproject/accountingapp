'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

const VideoCallFrame = dynamic(
  () => import('./VideoCallFrame').then((mod) => mod.VideoCallFrame),
  {
    ssr: false,
    loading: () => <div className="flex h-full items-center justify-center text-sm text-zinc-300">Loading video room…</div>,
  },
);

/**
 * Account-less guest join. Renders a name-entry screen, then mounts the same
 * prebuilt frame the host uses. Calls only our public POST /api/video/join —
 * no Daily specifics, no auth. On leave we show a friendly end screen (guests
 * don't own the session, so there's no ended_at to update — that's the host's).
 */

type Status = 'idle' | 'joining' | 'in-call' | 'left' | 'error';

export function GuestJoin({ roomName }: { roomName: string }) {
  const [name, setName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<{ roomUrl: string; token: string } | null>(null);

  const join = useCallback(async () => {
    setStatus('joining');
    setError(null);
    try {
      const res = await fetch('/api/video/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName, guestName: name.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Could not join the call (${res.status})`);
      }
      const data = (await res.json()) as { roomUrl: string; token: string };
      setCall(data);
      setStatus('in-call');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the call');
      setStatus('error');
    }
  }, [roomName, name]);

  const handleLeft = useCallback(() => {
    setCall(null);
    setStatus('left');
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
    setStatus('error');
    setCall(null);
  }, []);

  // Full-viewport overlay so the call isn't boxed into the narrow landing column.
  if (status === 'in-call' && call) {
    return (
      <div className="fixed inset-0 z-50 bg-zinc-950">
        <VideoCallFrame
          roomUrl={call.roomUrl}
          token={call.token}
          onLeft={handleLeft}
          onError={handleError}
          chat
        />
      </div>
    );
  }

  if (status === 'left') {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">You’ve left the call.</p>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Rejoin
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <label htmlFor="guest-name" className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
        Your name
      </label>
      <input
        id="guest-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && status !== 'joining') join();
        }}
        placeholder="e.g. Jordan"
        autoComplete="name"
        className="mt-2 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      />

      {error && (
        <p className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={join}
        disabled={status === 'joining'}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'joining' ? 'Joining…' : 'Join call'}
      </button>
    </div>
  );
}
