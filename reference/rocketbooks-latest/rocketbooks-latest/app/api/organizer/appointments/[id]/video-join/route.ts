import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { appointments } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { videoProvider } from '@/lib/video';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/** Last path segment of a Daily room URL is the room name. */
function roomNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    return seg ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure a live Daily room exists for this video appointment and return its
 * room name. Rooms are short-lived, so we provision on demand: reuse the room
 * stored in `location` if it's still valid, otherwise create a fresh one and
 * persist its URL. The client then joins via the public /video/join/<room>.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();
  const { id } = await ctx.params;

  // Demo workspace is read-only (provisioning persists a room URL).
  if (isDemoOrg(orgId)) {
    return NextResponse.json({ error: "This action isn't available in the demo workspace." }, { status: 403 });
  }

  if (!videoProvider.isConfigured()) {
    return NextResponse.json({ error: 'video calling is not configured' }, { status: 503 });
  }

  const [appt] = await db
    .select({ id: appointments.id, location: appointments.location, videoEnabled: appointments.videoEnabled })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, id),
        eq(appointments.userId, userId),
        eq(appointments.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!appt) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!appt.videoEnabled) {
    return NextResponse.json({ error: 'not a video meeting' }, { status: 400 });
  }

  // Reuse the existing room if it's still alive.
  const existingName = roomNameFromUrl(appt.location);
  if (existingName) {
    const room = await videoProvider.getRoom(existingName).catch(() => null);
    if (room) return NextResponse.json({ roomName: room.name });
  }

  // Provision a fresh room and remember its URL for next time.
  let room;
  try {
    room = await videoProvider.createRoom({ namePrefix: 'mtg' });
  } catch (err) {
    logger.error(
      { id, err: err instanceof Error ? err.message : String(err) },
      'appointment video-join: createRoom failed',
    );
    return NextResponse.json({ error: 'could not start the video room' }, { status: 502 });
  }

  await db
    .update(appointments)
    .set({ location: room.url, updatedAt: new Date().toISOString() })
    .where(eq(appointments.id, id));

  return NextResponse.json({ roomName: room.name });
}
