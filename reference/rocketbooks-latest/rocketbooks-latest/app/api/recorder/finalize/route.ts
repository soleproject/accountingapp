import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { recordingPath, uploadRecording } from '@/lib/storage/recordings';
import { runTranscription } from '@/lib/recorder/transcribe';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
// Deepgram async on a 30-min meeting typically returns in <60s, but Vercel
// hobby caps at 60. Set to the platform max for headroom; long meetings
// will need to move to Inngest later.
export const maxDuration = 300;

const ALLOWED_MIME = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/mpeg', 'audio/ogg']);
const MAX_BYTES = 50 * 1024 * 1024;

function extFor(mime: string): 'webm' | 'mp4' | 'ogg' {
  if (mime.startsWith('audio/mp4') || mime.startsWith('audio/mpeg')) return 'mp4';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  return 'webm';
}

export async function POST(req: Request) {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await isRecorderEnabled(user.id, orgId))) {
    return NextResponse.json({ error: 'recorder not enabled' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid form data' }, { status: 400 });
  }

  const recordingId = form.get('recordingId');
  const audio = form.get('audio');
  const durationRaw = form.get('durationS');

  if (typeof recordingId !== 'string' || !recordingId) {
    return NextResponse.json({ error: 'recordingId required' }, { status: 400 });
  }
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: 'audio file required' }, { status: 400 });
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: 'audio is empty' }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: 'audio too large' }, { status: 413 });
  }
  const mime = audio.type || 'audio/webm';
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `unsupported mime ${mime}` }, { status: 415 });
  }

  // Confirm the recording belongs to this user + org.
  const [rec] = await db
    .select({ id: recordings.id, status: recordings.status })
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, user.id), eq(recordings.organizationId, orgId)))
    .limit(1);
  if (!rec) return NextResponse.json({ error: 'recording not found' }, { status: 404 });
  if (rec.status !== 'uploading') {
    return NextResponse.json({ error: `recording is ${rec.status}, not uploading` }, { status: 409 });
  }

  const path = recordingPath(orgId, recordingId, extFor(mime));
  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    await uploadRecording(path, buf, mime);
    const durationS = typeof durationRaw === 'string' ? parseInt(durationRaw, 10) || null : null;
    await db
      .update(recordings)
      .set({
        storagePath: path,
        durationS,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(recordings.id, recordingId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ recordingId, err: msg }, 'recorder upload failed');
    await db
      .update(recordings)
      .set({ status: 'failed', failureReason: `upload: ${msg}`.slice(0, 1000) })
      .where(eq(recordings.id, recordingId));
    return NextResponse.json({ error: 'upload failed', detail: msg }, { status: 500 });
  }

  try {
    await runTranscription(recordingId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { recordingId, status: 'failed', error: 'transcription failed', detail: msg },
      { status: 502 },
    );
  }

  return NextResponse.json({ recordingId, status: 'ready' });
}
