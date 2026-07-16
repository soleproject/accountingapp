import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, users } from '@/db/schema';
import { videoProvider } from '@/lib/video';
import { emailTranscriptIfAny } from '@/lib/video/transcript-email';
import { logger } from '@/lib/logger';

export const maxDuration = 30;

/**
 * POST /api/video/transcript-webhook — PUBLIC, signature-verified.
 *
 * Daily fires `transcript.ready-to-download` when a call's transcription has
 * finished. That's our reliable "transcription is done" signal (fires after the
 * call ends, by which time the host's live lines have all been persisted), so we
 * email the host the real-name transcript we captured — gated to once via
 * transcript_emailed_at — then delete Daily's stored copy.
 */
export async function POST(req: Request) {
  const raw = await req.text();

  let verified: boolean;
  try {
    verified = videoProvider.verifyWebhook(
      req.headers.get('x-webhook-timestamp'),
      req.headers.get('x-webhook-signature'),
      raw,
    );
  } catch {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }
  if (!verified) return NextResponse.json({ error: 'invalid signature' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Daily's create-time verification handshake + unrelated events → 200.
  const type = (body.type ?? body.event) as string | undefined;
  if (type !== 'transcript.ready-to-download') return NextResponse.json({ ok: true });

  const payload = (body.payload ?? body) as Record<string, unknown>;
  const roomName = (payload.room_name ?? payload.roomName) as string | undefined;
  const transcriptId = (payload.transcriptId ?? payload.id ?? payload.transcript_id) as string | undefined;
  if (!roomName) return NextResponse.json({ ok: true });

  try {
    const [session] = await db
      .select({
        id: videoSessions.id,
        hostUserId: videoSessions.hostUserId,
        emailedAt: videoSessions.transcriptEmailedAt,
      })
      .from(videoSessions)
      .where(eq(videoSessions.roomName, roomName))
      .limit(1);

    if (session && !session.emailedAt) {
      const [host] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, session.hostUserId))
        .limit(1);
      await emailTranscriptIfAny(session.id, host?.email);
      await db
        .update(videoSessions)
        .set({ transcriptEmailedAt: new Date().toISOString() })
        .where(eq(videoSessions.id, session.id));
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), roomName },
      'transcript webhook handling failed',
    );
  }

  // Clean up Daily's stored transcript — we email from our own real-name lines.
  if (transcriptId) {
    try {
      await videoProvider.deleteTranscript(transcriptId);
    } catch {
      // best-effort; the transcript also expires on Daily's side
    }
  }

  return NextResponse.json({ ok: true });
}
