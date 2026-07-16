import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, videoParticipants, videoChatMessages } from '@/db/schema';
import { getSession } from '@/lib/auth/session';

export const maxDuration = 15;

/**
 * POST /api/video/sessions/:id/chat
 *
 * Persists one chat message. Host-only: the host's browser posts its own sends
 * and the guest's received messages, so the whole conversation is saved without
 * a public write endpoint. participant_id is resolved from daily_session_id for
 * attribution (null if the join wasn't recorded yet — the message still saves).
 */

const Body = z.object({
  dailySessionId: z.string().min(1).max(120),
  senderName: z.string().min(1).max(120),
  text: z.string().min(1).max(4000),
  sentAt: z.string().min(1).max(40),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const msg = parsed.data;

  // Scope: only the call's host may write its record.
  const [session] = await db
    .select({ id: videoSessions.id })
    .from(videoSessions)
    .where(and(eq(videoSessions.id, id), eq(videoSessions.hostUserId, user.id)))
    .limit(1);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  // Best-effort attribution to a participant row (nullable on miss).
  const [participant] = await db
    .select({ id: videoParticipants.id })
    .from(videoParticipants)
    .where(and(eq(videoParticipants.sessionId, id), eq(videoParticipants.dailySessionId, msg.dailySessionId)))
    .limit(1);

  await db.insert(videoChatMessages).values({
    id: randomUUID(),
    sessionId: id,
    participantId: participant?.id ?? null,
    senderName: msg.senderName,
    text: msg.text,
    sentAt: msg.sentAt,
  });

  return NextResponse.json({ ok: true });
}
