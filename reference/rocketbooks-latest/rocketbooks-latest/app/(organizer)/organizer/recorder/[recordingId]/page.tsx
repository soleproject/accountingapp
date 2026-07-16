import { notFound } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingOutputs, recordingSegments } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { RecordingDetail } from '@/components/recorder/RecordingDetail';
import type { Draft } from '@/components/recorder/RecorderShared';

export default async function RecordingDetailPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const { recordingId } = await params;

  const enabled = await isRecorderEnabled(user.id, orgId);
  const demo = isDemoOrg(orgId);
  if (!enabled && !demo) notFound();

  // Demo org is a shared, read-only showcase: drop the per-viewer user filter
  // so seeded demo recordings render for anyone (mirrors the list page).
  const [rec] = await db
    .select({
      id: recordings.id,
      userId: recordings.userId,
      title: recordings.title,
      status: recordings.status,
      source: recordings.source,
      createdAt: recordings.createdAt,
      failureReason: recordings.failureReason,
    })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.organizationId, orgId),
        demo ? undefined : eq(recordings.userId, user.id),
      ),
    )
    .limit(1);
  if (!rec) notFound();

  const [output] = await db
    .select({
      summaryMd: recordingOutputs.summaryMd,
      actionItems: recordingOutputs.actionItems,
      decisions: recordingOutputs.decisions,
      approvedAt: recordingOutputs.approvedAt,
    })
    .from(recordingOutputs)
    .where(eq(recordingOutputs.recordingId, recordingId))
    .limit(1);

  const segments = await db
    .select({
      id: recordingSegments.id,
      speakerLabel: recordingSegments.speakerLabel,
      startMs: recordingSegments.startMs,
      endMs: recordingSegments.endMs,
      text: recordingSegments.text,
    })
    .from(recordingSegments)
    .where(eq(recordingSegments.recordingId, recordingId))
    .orderBy(asc(recordingSegments.startMs));

  const draft: Draft | null = output
    ? {
        summaryMd: output.summaryMd ?? '',
        actionItems: (output.actionItems as Draft['actionItems']) ?? [],
        decisions: (output.decisions as string[]) ?? [],
        approvedAt: output.approvedAt,
      }
    : null;

  // Only the owner can create notes/tasks (the approve API filters by user);
  // demo viewers see the draft read-only.
  const canApprove = rec.userId === user.id;

  return (
    <div className="mx-auto max-w-3xl">
      <RecordingDetail
        recordingId={rec.id}
        title={rec.title}
        status={rec.status}
        source={rec.source}
        createdAt={rec.createdAt}
        failureReason={rec.failureReason}
        initialDraft={draft}
        segments={segments}
        canApprove={canApprove}
      />
    </div>
  );
}
