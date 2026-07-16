import { NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingSegments } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ recordingId: string }> },
) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const { recordingId } = await ctx.params;

  const [rec] = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, user.id), eq(recordings.organizationId, orgId)))
    .limit(1);
  if (!rec) return NextResponse.json({ error: 'not found' }, { status: 404 });

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

  return NextResponse.json({ segments });
}
