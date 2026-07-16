import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, videoParticipants } from '@/db/schema';
import { getSession } from '@/lib/auth/session';
import { recordServiceUsage } from '@/lib/ai/usage';

export const maxDuration = 15;

/**
 * PATCH /api/video/sessions/:id
 *
 * Marks a call ended (sets ended_at = now). Called when the host clicks Leave.
 * Scoped to the host: a user can only end their own session, and only if it
 * isn't already ended (idempotent — a double-leave is a no-op success).
 */
export async function PATCH(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const endedAt = new Date().toISOString();

  const updated = await db
    .update(videoSessions)
    .set({ endedAt })
    .where(
      and(
        eq(videoSessions.id, id),
        eq(videoSessions.hostUserId, user.id),
        isNull(videoSessions.endedAt),
      ),
    )
    .returning({ id: videoSessions.id });

  // Close out anyone still "in" the call (the host never gets a participant-left
  // for itself, and a guest may not have reported leaving). Only runs when we
  // actually ended the session this call.
  if (updated.length > 0) {
    await db
      .update(videoParticipants)
      .set({ leftAt: endedAt })
      .where(and(eq(videoParticipants.sessionId, id), isNull(videoParticipants.leftAt)));
    // The transcript email is sent from the Daily transcript-ready webhook (it
    // fires once Daily has finalized the transcript), not here on leave.

    // Daily.co bills per participant-minute. Now that every participant has a
    // leftAt, the session's billable minutes are the summed presence windows.
    const parts = await db
      .select({ joinedAt: videoParticipants.joinedAt, leftAt: videoParticipants.leftAt })
      .from(videoParticipants)
      .where(eq(videoParticipants.sessionId, id));
    let minutes = 0;
    for (const p of parts) {
      if (p.leftAt) {
        minutes += Math.max(0, (new Date(p.leftAt).getTime() - new Date(p.joinedAt).getTime()) / 60_000);
      }
    }
    if (minutes > 0) {
      recordServiceUsage(
        { userId: user.id, orgId: null, actor: 'video', feature: 'video-call' },
        { provider: 'daily', category: 'video', unit: 'minutes', quantity: minutes, rateKey: 'daily:participant-minute' },
      );
    }
  }

  // No row updated → either not found, not yours, or already ended. All three
  // are fine to treat as success from the client's perspective (leave is leave).
  return NextResponse.json({ ended: updated.length > 0 });
}
