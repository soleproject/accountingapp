import { NextResponse } from 'next/server';
import { z } from 'zod';
import { videoProvider } from '@/lib/video';
import { logger } from '@/lib/logger';

export const maxDuration = 30;

/**
 * POST /api/video/join  — PUBLIC (no auth).
 *
 * Mints a GUEST (non-owner, short-lived) meeting token for an existing room so
 * someone without a RocketSuite account can join via an invite link. Access
 * control is the unguessable room name itself (22 random chars): we only mint a
 * token if the room currently exists and hasn't expired. Guests never get the
 * API key, never get owner rights, and can't enumerate rooms.
 *
 * Note: this intentionally does NOT touch video_sessions — guests aren't
 * persisted yet (that's a later extension). The host's session row is the
 * source of truth for history.
 */

const Body = z.object({
  roomName: z.string().min(1).max(80),
  guestName: z.string().min(1).max(80).optional(),
});

export async function POST(req: Request) {
  if (!videoProvider.isConfigured()) {
    return NextResponse.json({ error: 'Video calling is not configured' }, { status: 503 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const { roomName, guestName } = parsed.data;

  try {
    const room = await videoProvider.getRoom(roomName);
    if (!room) {
      return NextResponse.json(
        { error: 'This call link is invalid or has expired' },
        { status: 404 },
      );
    }

    const token = await videoProvider.createMeetingToken({
      roomName: room.name,
      userName: guestName || 'Guest',
      isOwner: false,
      expiresInSeconds: Math.max(60, room.expiresAt - Math.floor(Date.now() / 1000)),
    });

    return NextResponse.json({ roomUrl: room.url, token, expiresAt: room.expiresAt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, roomName }, 'video guest join failed');
    return NextResponse.json({ error: 'Failed to join the call' }, { status: 502 });
  }
}
