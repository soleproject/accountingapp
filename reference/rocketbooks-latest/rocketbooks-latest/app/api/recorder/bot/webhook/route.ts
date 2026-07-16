import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingBotSessions } from '@/db/schema/schema';
import { runTranscription } from '@/lib/recorder/transcribe';
import {
  verifyWebhook,
  parseWebhookEvent,
  getBot,
  isTerminalDone,
  isTerminalFatal,
} from '@/lib/recorder/recall';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Recall.ai webhook receiver for the meeting-bot capture source.
 *
 * Unauthenticated by session — verified instead by the Svix signature over
 * the raw request body (RECALL_WEBHOOK_SECRET). We must read the body as
 * text BEFORE parsing so the signature check sees the exact bytes Recall
 * signed.
 *
 * On a terminal "done" event we pull the recording media URL and run the
 * shared Deepgram → draftSummary pipeline inline. Phase 1 already runs
 * transcription inline; if long meetings exceed the route ceiling, move the
 * runTranscription call to an Inngest function (see note in transcribe.ts).
 */
export async function POST(req: Request) {
  const raw = await req.text();

  let verified: boolean;
  try {
    verified = verifyWebhook({
      id: req.headers.get('svix-id'),
      timestamp: req.headers.get('svix-timestamp'),
      signatureHeader: req.headers.get('svix-signature'),
      body: raw,
    });
  } catch (err) {
    // Missing secret — misconfiguration, not the caller's fault. 500 so it
    // shows up in logs/alerts rather than being silently dropped.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'recall webhook: verify misconfigured');
    return NextResponse.json({ error: 'webhook not configured' }, { status: 500 });
  }
  if (!verified) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const event = parseWebhookEvent(body);
  if (!event.botId) {
    // Nothing to correlate — ack so Recall doesn't retry forever.
    return NextResponse.json({ ok: true, ignored: 'no bot id' });
  }

  const [session] = await db
    .select({
      id: recordingBotSessions.id,
      recordingId: recordingBotSessions.recordingId,
      botStatus: recordingBotSessions.botStatus,
    })
    .from(recordingBotSessions)
    .where(eq(recordingBotSessions.recallBotId, event.botId))
    .limit(1);
  if (!session) {
    logger.warn({ botId: event.botId }, 'recall webhook: no session for bot id');
    return NextResponse.json({ ok: true, ignored: 'unknown bot' });
  }

  // Always record the latest raw event + a coarse bot_status for debugging.
  const code = event.statusCode;
  const nextBotStatus = isTerminalDone(code)
    ? 'done'
    : isTerminalFatal(code)
      ? 'fatal'
      : code === 'in_call_recording' || code === 'in_call'
        ? 'in_call'
        : session.botStatus;
  await db
    .update(recordingBotSessions)
    .set({ botStatus: nextBotStatus, lastEvent: body, updatedAt: new Date().toISOString() })
    .where(eq(recordingBotSessions.id, session.id));

  // Reflect the bot lifecycle on the recordings status row for the UI.
  if (nextBotStatus === 'in_call') {
    await db
      .update(recordings)
      .set({ status: 'in_call', updatedAt: new Date().toISOString() })
      .where(eq(recordings.id, session.recordingId));
  }

  if (isTerminalFatal(code)) {
    await db
      .update(recordings)
      .set({ status: 'failed', failureReason: `recall bot ${code}`, updatedAt: new Date().toISOString() })
      .where(eq(recordings.id, session.recordingId));
    return NextResponse.json({ ok: true });
  }

  if (isTerminalDone(code)) {
    // Idempotency: if we've already processed this bot, don't re-transcribe.
    if (session.botStatus === 'done') {
      return NextResponse.json({ ok: true, ignored: 'already processed' });
    }
    try {
      // The webhook payload may not carry the media URL — fetch the bot to
      // resolve a downloadable recording URL.
      const bot = await getBot(event.botId);
      if (!bot.mediaUrl) {
        throw new Error('recall bot done but no media URL resolved');
      }
      await db
        .update(recordingBotSessions)
        .set({ mediaUrl: bot.mediaUrl, updatedAt: new Date().toISOString() })
        .where(eq(recordingBotSessions.id, session.id));

      await runTranscription(session.recordingId, { audioUrl: bot.mediaUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ recordingId: session.recordingId, err: msg }, 'recall webhook: pipeline failed');
      // runTranscription already sets status='failed' on its own errors; this
      // catch also covers the getBot/media-resolution step.
      await db
        .update(recordings)
        .set({ status: 'failed', failureReason: msg.slice(0, 1000), updatedAt: new Date().toISOString() })
        .where(eq(recordings.id, session.recordingId));
      // 200 anyway: a retry would re-run a non-deterministic pipeline; we've
      // captured the failure and the user can re-dispatch.
      return NextResponse.json({ ok: true, error: msg });
    }
  }

  return NextResponse.json({ ok: true });
}
