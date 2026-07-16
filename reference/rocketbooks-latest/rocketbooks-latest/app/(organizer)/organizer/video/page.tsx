import Link from 'next/link';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions } from '@/db/schema';
import { appointments, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { videoProvider } from '@/lib/video';
import { formatWhen, formatDuration } from '@/lib/video/format';
import { VideoRoomLauncher } from '@/components/video/VideoRoomLauncher';

/** Local `YYYY-MM-DD` for deep-linking into the calendar day view. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Organizer Video — start a 1:1 call, and a history of recent calls that link
// to each call's session record (Phase A of the complete session record).
export const dynamic = 'force-dynamic';

export default async function VideoPage() {
  const user = await requireSession();
  // Server-side check so the page can show a friendly notice instead of letting
  // the user click into a 503. videoProvider is server-only — safe here.
  const configured = videoProvider.isConfigured();

  const orgId = await getCurrentOrgId();
  const nowIso = new Date().toISOString();

  const [org] = await db
    .select({ transcription: organizations.videoTranscriptionEnabled })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const transcription = org?.transcription ?? false;

  const [recent, upcoming] = await Promise.all([
    db
      .select({
        id: videoSessions.id,
        createdAt: videoSessions.createdAt,
        startedAt: videoSessions.startedAt,
        endedAt: videoSessions.endedAt,
      })
      .from(videoSessions)
      .where(eq(videoSessions.hostUserId, user.id))
      .orderBy(desc(videoSessions.createdAt))
      .limit(10),
    // Scheduled video meetings created from the calendar (video_enabled), still
    // upcoming. The Daily room is provisioned when the host joins from the
    // calendar popover.
    db
      .select({
        id: appointments.id,
        title: appointments.title,
        startsAt: appointments.startsAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.organizationId, orgId),
          eq(appointments.userId, user.id),
          eq(appointments.videoEnabled, true),
          gte(appointments.startsAt, nowIso),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(10),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Video</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          One-on-one video calls with screen sharing, right inside RocketSuite.
        </p>
      </header>

      <VideoRoomLauncher configured={configured} transcription={transcription} />

      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Upcoming meetings</h2>
          <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {upcoming.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/organizer/calendar?view=day&date=${dayKey(m.startsAt)}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <span className="truncate text-zinc-900 dark:text-zinc-100">{m.title}</span>
                  <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{formatWhen(m.startsAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Recent calls</h2>
          <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
            {recent.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/organizer/video/${s.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <span className="text-zinc-900 dark:text-zinc-100">{formatWhen(s.createdAt)}</span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {formatDuration(s.startedAt, s.endedAt)} · {s.endedAt ? 'Ended' : 'Ongoing'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
