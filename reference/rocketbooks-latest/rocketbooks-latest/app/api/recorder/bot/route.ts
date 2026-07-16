import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingBotSessions } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { createBot, detectPlatform } from '@/lib/recorder/recall';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// platform → recordings.source value
const SOURCE_BY_PLATFORM = {
  zoom: 'zoom_bot',
  teams: 'teams_bot',
  meet: 'meet_bot',
} as const;

const Schema = z.object({
  meetingUrl: z.string().url().max(2048),
  title: z.string().min(1).max(255).optional(),
  contactId: z.string().min(1).max(64).optional(),
  // Operator must acknowledge the recording disclosure before we dispatch a
  // bot. The bot also announces itself in-meeting via its display name.
  consentAck: z.literal(true),
});

export async function POST(req: Request) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await isRecorderEnabled(user.id, orgId))) {
    return NextResponse.json({ error: 'recorder not enabled' }, { status: 404 });
  }

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
  const { meetingUrl, title, contactId } = parsed.data;

  const platform = detectPlatform(meetingUrl);
  if (!platform) {
    return NextResponse.json(
      { error: 'unsupported meeting link — must be a Zoom, Microsoft Teams, or Google Meet URL' },
      { status: 400 },
    );
  }

  const recordingId = randomUUID();
  const sessionId = randomUUID();

  // Create the rows first (status='scheduled') so the recording exists even
  // if the Recall call is slow; then dispatch the bot and store its id.
  try {
    await db.insert(recordings).values({
      id: recordingId,
      organizationId: orgId,
      userId: user.id,
      contactId: contactId ?? null,
      title: title ?? null,
      source: SOURCE_BY_PLATFORM[platform],
      status: 'scheduled',
      startedAt: new Date().toISOString(),
    });
    await db.insert(recordingBotSessions).values({
      id: sessionId,
      recordingId,
      platform,
      meetingUrl,
      botStatus: 'dispatched',
      consentAck: true,
      consentBy: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId, userId: user.id, err: msg }, 'recorder bot dispatch: row insert failed');
    return NextResponse.json({ error: 'insert failed', detail: msg }, { status: 500 });
  }

  try {
    const { botId } = await createBot(meetingUrl);
    await db
      .update(recordingBotSessions)
      .set({ recallBotId: botId, botStatus: 'joining', updatedAt: new Date().toISOString() })
      .where(eq(recordingBotSessions.id, sessionId));
    return NextResponse.json({ recordingId, botId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ recordingId, err: msg }, 'recorder bot dispatch: Recall createBot failed');
    // Mark the session/recording failed so it doesn't sit "scheduled" forever.
    await db
      .update(recordingBotSessions)
      .set({ botStatus: 'fatal', updatedAt: new Date().toISOString() })
      .where(eq(recordingBotSessions.id, sessionId));
    await db
      .update(recordings)
      .set({ status: 'failed', failureReason: msg.slice(0, 1000), updatedAt: new Date().toISOString() })
      .where(eq(recordings.id, recordingId));
    return NextResponse.json({ error: 'could not dispatch notetaker', detail: msg }, { status: 502 });
  }
}
