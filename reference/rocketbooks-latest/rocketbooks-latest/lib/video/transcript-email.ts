import 'server-only';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { videoSessions, videoTranscriptLines } from '@/db/schema';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { formatWhen, formatDuration } from '@/lib/video/format';
import { logger } from '@/lib/logger';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Email the host a copy of a call's transcript, if there is one. Best-effort and
 * env-guarded (sendTransactionalEmail no-ops without RESEND_API_KEY), so it
 * never blocks the leave flow. No transcript lines → no email.
 */
export async function emailTranscriptIfAny(sessionId: string, toEmail: string | null | undefined): Promise<void> {
  if (!toEmail) return;
  try {
    const lines = await db
      .select()
      .from(videoTranscriptLines)
      .where(eq(videoTranscriptLines.sessionId, sessionId))
      .orderBy(asc(videoTranscriptLines.saidAt));
    if (lines.length === 0) return;

    const [session] = await db
      .select()
      .from(videoSessions)
      .where(eq(videoSessions.id, sessionId))
      .limit(1);
    const when = session ? formatWhen(session.createdAt) : '';
    const duration = session ? formatDuration(session.startedAt, session.endedAt) : '';

    const text = `Video call transcript — ${when} (${duration})\n\n${lines
      .map((l) => `${l.speakerName}: ${l.text}`)
      .join('\n')}`;

    const html =
      `<h2 style="font-family:sans-serif;margin:0 0 4px">Video call transcript</h2>` +
      `<p style="font-family:sans-serif;color:#666;margin:0 0 12px">${escapeHtml(when)} · ${escapeHtml(duration)}</p>` +
      `<div style="font-family:sans-serif;line-height:1.5">${lines
        .map((l) => `<p style="margin:6px 0"><strong>${escapeHtml(l.speakerName)}:</strong> ${escapeHtml(l.text)}</p>`)
        .join('')}</div>`;

    await sendTransactionalEmail({
      to: toEmail,
      subject: `Transcript — video call ${when}`,
      text,
      html,
      usage: { userId: session?.hostUserId ?? null, orgId: null, actor: 'system', feature: 'video-transcript-email' },
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), sessionId },
      'transcript email failed',
    );
  }
}
