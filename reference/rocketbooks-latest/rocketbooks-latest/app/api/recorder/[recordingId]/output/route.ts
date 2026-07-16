import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingOutputs } from '@/db/schema/schema';
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

  const [output] = await db
    .select({
      summaryMd: recordingOutputs.summaryMd,
      actionItems: recordingOutputs.actionItems,
      decisions: recordingOutputs.decisions,
      approvedAt: recordingOutputs.approvedAt,
      generatedAt: recordingOutputs.generatedAt,
    })
    .from(recordingOutputs)
    .where(eq(recordingOutputs.recordingId, recordingId))
    .limit(1);

  if (!output) return NextResponse.json({ output: null });
  return NextResponse.json({ output });
}
