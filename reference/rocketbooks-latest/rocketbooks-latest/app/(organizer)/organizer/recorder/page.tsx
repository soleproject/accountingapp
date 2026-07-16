import { notFound } from 'next/navigation';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { BOT_SOURCES } from '@/lib/recorder/sources';
import { RecorderWorkspace } from '@/components/recorder/RecorderWorkspace';

export default async function RecorderPage() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  // The demo org is a shared showcase: always expose the recorder there so the
  // seeded demo recordings are visible, regardless of the viewer's own flag.
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
    // Demo org is shared/read-only: drop the per-viewer user filter so the
    // seeded demo recordings render for anyone (mirrors the accounting demo).
    // Bot/meeting recordings live on the Notetaker page; this page shows only
    // mic recordings made here.
    .where(
      and(
        eq(recordings.organizationId, orgId),
        notInArray(recordings.source, [...BOT_SOURCES]),
        isDemoOrg(orgId) ? undefined : eq(recordings.userId, user.id),
      ),
    )
    .orderBy(desc(recordings.createdAt))
    .limit(10);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Recorder</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Record a conversation, get a diarized transcript. Notes and follow-up tasks are coming next.
        </p>
      </header>

      <RecorderWorkspace initialRecordings={rows} />
    </div>
  );
}
