import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/db/client';
import { videoSessions } from '@/db/schema';
import { getSession } from '@/lib/auth/session';
import { videoProvider } from '@/lib/video';
import { logger } from '@/lib/logger';

export const maxDuration = 30;

/**
 * POST /api/video/rooms
 *
 * Creates a short-lived, private, randomly-named video room on demand and
 * returns it together with an OWNER meeting token for the signed-in user
 * (the host). DAILY_API_KEY stays server-side — the client only ever receives
 * the room URL + a scoped token, never the API key.
 *
 * Guest join tokens (for the other participant) are minted by a separate
 * route in Phase 3 so the unauthenticated case can be handled distinctly.
 */

const Body = z
  .object({
    // Optional display name for the host in the call. Defaults to their email.
    hostName: z.string().min(1).max(80).optional(),
  })
  .optional();

export async function POST(req: Request) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  if (!videoProvider.isConfigured()) {
    return NextResponse.json(
      { error: 'Video calling is not configured' },
      { status: 503 },
    );
  }

  // Body is optional — tolerate an empty/absent payload.
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const hostName =
    parsed.data?.hostName ||
    (user.user_metadata?.full_name as string | undefined) ||
    user.email ||
    'Host';

  try {
    const room = await videoProvider.createRoom();
    const token = await videoProvider.createMeetingToken({
      roomName: room.name,
      userName: hostName,
      isOwner: true,
      expiresInSeconds: Math.max(60, room.expiresAt - Math.floor(Date.now() / 1000)),
    });

    // Persist a host-side history row. Best-effort: a logging hiccup must never
    // sink a working call, so a failed insert just means no `sessionId` (and no
    // ended_at tracking) for this call — the call itself still proceeds.
    let sessionId: string | null = randomUUID();
    try {
      await db.insert(videoSessions).values({
        id: sessionId,
        hostUserId: user.id,
        roomName: room.name,
        roomUrl: room.url,
        expiresAt: new Date(room.expiresAt * 1000).toISOString(),
      });
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      logger.warn({ err: msg, userId: user.id, roomName: room.name }, 'video session insert failed');
      sessionId = null;
    }

    return NextResponse.json({
      provider: videoProvider.id,
      sessionId,
      roomName: room.name,
      roomUrl: room.url,
      token,
      expiresAt: room.expiresAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, userId: user.id }, 'video createRoom failed');
    return NextResponse.json({ error: 'Failed to create room' }, { status: 502 });
  }
}
