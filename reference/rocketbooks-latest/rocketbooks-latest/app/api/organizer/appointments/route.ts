import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/db/client';
import { appointments } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { videoProvider } from '@/lib/video';

const DEMO_READONLY = { error: "This action isn't available in the demo workspace." };

export const runtime = 'nodejs';

const Schema = z.object({
  title: z.string().trim().min(1).max(255),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  location: z.string().trim().max(2048).nullish(),
  description: z.string().trim().max(8000).nullish(),
  guestEmails: z.array(z.string().trim().email()).max(50).optional(),
  videoEnabled: z.boolean().optional(),
});

/**
 * Create an organizer appointment. A video meeting just sets video_enabled;
 * the Daily room is provisioned on-demand at join time (rooms are short-lived),
 * so we don't burn a room here that would expire before a future meeting.
 */
export async function POST(req: Request) {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = await getCurrentOrgId();

  // Demo workspace is read-only — no writes to the shared seeded data.
  if (isDemoOrg(orgId)) return NextResponse.json(DEMO_READONLY, { status: 403 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = Schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request', issues: parsed.error.issues }, { status: 400 });
  }
  const { title, startsAt, endsAt, location, description, guestEmails, videoEnabled } = parsed.data;

  // Fail fast if a video meeting is requested but the provider isn't set up,
  // so the user isn't surprised by a dead Join button later.
  if (videoEnabled && !videoProvider.isConfigured()) {
    return NextResponse.json({ error: 'video calling is not configured' }, { status: 503 });
  }

  const id = randomUUID();
  await db.insert(appointments).values({
    id,
    userId,
    organizationId: orgId,
    title,
    description: description ?? null,
    startsAt,
    endsAt: endsAt ?? null,
    location: location ?? null,
    source: 'manual',
    videoEnabled: videoEnabled ?? false,
    guestEmails: guestEmails && guestEmails.length > 0 ? guestEmails.join(', ') : null,
  });

  return NextResponse.json({ id }, { status: 201 });
}
