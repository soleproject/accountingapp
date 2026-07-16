import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingOutputs, notes, tasks } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const Schema = z.object({
  summaryMd: z.string().max(50_000),
  actionItems: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        dueHint: z.string().max(120).nullable().optional(),
      }),
    )
    .max(50),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ recordingId: string }> },
) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const { recordingId } = await ctx.params;

  const [rec] = await db
    .select({ id: recordings.id, contactId: recordings.contactId, title: recordings.title })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, user.id), eq(recordings.organizationId, orgId)))
    .limit(1);
  if (!rec) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const { summaryMd, actionItems } = parsed.data;

  try {
    const noteId = randomUUID();
    await db.insert(notes).values({
      id: noteId,
      userId: user.id,
      organizationId: orgId,
      contactId: rec.contactId,
      body: summaryMd,
      source: 'recording',
    });

    const insertedTaskIds: string[] = [];
    for (const item of actionItems) {
      const taskId = randomUUID();
      insertedTaskIds.push(taskId);
      await db.insert(tasks).values({
        id: taskId,
        userId: user.id,
        organizationId: orgId,
        product: 'organizer',
        page: '/organizer/recorder',
        entityId: recordingId,
        entityType: 'recording',
        title: item.text,
        description: item.dueHint ? `Due hint: ${item.dueHint}` : null,
        status: 'OPEN',
        source: 'recording',
        autoCreated: true,
        reviewRequired: true,
      });
    }

    await db
      .update(recordingOutputs)
      .set({ approvedAt: new Date().toISOString(), approvedBy: user.id, updatedAt: new Date().toISOString() })
      .where(eq(recordingOutputs.recordingId, recordingId));

    return NextResponse.json({ ok: true, noteId, taskIds: insertedTaskIds });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ recordingId, err: msg }, 'recorder approve failed');
    return NextResponse.json({ error: 'approve failed', detail: msg }, { status: 500 });
  }
}
