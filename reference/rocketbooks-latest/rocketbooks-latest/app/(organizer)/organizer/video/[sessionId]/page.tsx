import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, videoParticipants, videoChatMessages } from '@/db/schema';
import { requireSession } from '@/lib/auth/session';
import { formatWhen, formatDuration } from '@/lib/video/format';

// Session record (Phase A): who was in the call, when, and for how long.
// Transcript + chat sections land in later phases.
export const dynamic = 'force-dynamic';

export default async function VideoSessionRecordPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const user = await requireSession();
  const { sessionId } = await params;

  // Scope to the host — only the call owner can view its record.
  const [session] = await db
    .select()
    .from(videoSessions)
    .where(and(eq(videoSessions.id, sessionId), eq(videoSessions.hostUserId, user.id)))
    .limit(1);
  if (!session) notFound();

  const participants = await db
    .select()
    .from(videoParticipants)
    .where(eq(videoParticipants.sessionId, sessionId))
    .orderBy(asc(videoParticipants.joinedAt));

  const chatMessages = await db
    .select()
    .from(videoChatMessages)
    .where(eq(videoChatMessages.sessionId, sessionId))
    .orderBy(asc(videoChatMessages.sentAt));

  const ended = !!session.endedAt;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/organizer/video" className="text-sm text-sky-600 hover:underline dark:text-sky-400">
          ← Video
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Call record</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{formatWhen(session.createdAt)}</p>
      </div>

      <dl className="grid grid-cols-3 gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</dt>
          <dd className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">{ended ? 'Ended' : 'Ongoing'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Duration</dt>
          <dd className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {formatDuration(session.startedAt, session.endedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Participants</dt>
          <dd className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">{participants.length}</dd>
        </div>
      </dl>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Participants</h2>
        {participants.length === 0 ? (
          <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
            No participants were recorded for this call.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {participants.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.displayName}</div>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Joined {formatWhen(p.joinedAt)}
                    {p.leftAt ? ` · Left ${formatWhen(p.leftAt)}` : ' · still in call'}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    p.role === 'host'
                      ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
                      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}
                >
                  {p.role === 'host' ? 'Host' : 'Guest'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Chat</h2>
        {chatMessages.length === 0 ? (
          <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
            No chat messages in this call.
          </p>
        ) : (
          <ul className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {chatMessages.map((m) => (
              <li key={m.id} className="text-sm">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{m.senderName}</span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{formatWhen(m.sentAt)}</span>
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{m.text}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Transcript section hooks in here in Phase C. */}
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Transcript will appear here once that phase is enabled.
      </p>
    </div>
  );
}
