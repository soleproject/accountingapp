import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, videoParticipants } from '@/db/schema';
import { getSession } from '@/lib/auth/session';

export const maxDuration = 15;

/**
 * POST /api/video/sessions/:id/participants
 *
 * Records a join/leave for the session (the "who was here, and when" part of
 * the session record). Host-only and best-effort — the host's browser reports
 * its own join plus the guest's join/leave from the Daily call object.
 *
 * On the first join we also stamp the session's started_at (the call's real
 * start, vs created_at which is when the room was minted).
 */

const Body = z.object({
  action: z.enum(['join', 'leave']),
  dailySessionId: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  role: z.enum(['host', 'guest']),
  at: z.string().min(1).max(40), // ISO timestamp from the client
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const evt = parsed.data;

  // Scope: only the call's host may write its record.
  const [session] = await db
    .select({ id: videoSessions.id, startedAt: videoSessions.startedAt })
    .from(videoSessions)
    .where(and(eq(videoSessions.id, id), eq(videoSessions.hostUserId, user.id)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  if (evt.action === 'join') {
    // Idempotent on (session_id, daily_session_id): a re-reported join is a no-op.
    await db
      .insert(videoParticipants)
      .values({
        id: randomUUID(),
        sessionId: id,
        userId: evt.role === 'host' ? user.id : null,
        displayName: evt.name,
        dailySessionId: evt.dailySessionId,
        role: evt.role,
        joinedAt: evt.at,
      })
      .onConflictDoNothing();

    if (!session.startedAt) {
      await db
        .update(videoSessions)
        .set({ startedAt: evt.at })
        .where(and(eq(videoSessions.id, id), isNull(videoSessions.startedAt)));
    }
  } else {
    await db
      .update(videoParticipants)
      .set({ leftAt: evt.at })
      .where(
        and(
          eq(videoParticipants.sessionId, id),
          eq(videoParticipants.dailySessionId, evt.dailySessionId),
          isNull(videoParticipants.leftAt),
        ),
      );
  }

  return NextResponse.json({ ok: true });
}
