import { notFound } from 'next/navigation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { BOT_SOURCES } from '@/lib/recorder/sources';
import { NotetakerWorkspace } from '@/components/recorder/NotetakerWorkspace';

export default async function NotetakerPage() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  // Notetaker shares the recorder feature flag. The demo org is a shared
  // showcase: always expose it there so seeded demo data is visible.
  const enabled = await isRecorderEnabled(user.id, orgId);
  if (!enabled && !isDemoOrg(orgId)) notFound();

  const rows = await db
    .select({
      id: recordings.id,
      title: recordings.title,
      createdAt: recordings.createdAt,
      status: recordings.status,
    })
    .from(recordings)
    // Only bot/meeting recordings belong here; mic recordings live on the
    // Recorder page. Demo org is shared/read-only: drop the per-viewer filter.
    .where(
      and(
        eq(recordings.organizationId, orgId),
        inArray(recordings.source, [...BOT_SOURCES]),
        isDemoOrg(orgId) ? undefined : eq(recordings.userId, user.id),
      ),
    )
    .orderBy(desc(recordings.createdAt))
    .limit(10);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Notetaker</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Send a notetaker bot into a Zoom, Microsoft Teams, or Google Meet call. It records, then drafts
          your notes and follow-up tasks when the meeting ends.
        </p>
      </header>

      <NotetakerWorkspace recentMeetings={rows} />
    </div>
  );
}
