import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/db/client';
import { recordings } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isRecorderEnabled } from '@/lib/recorder/access';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const Schema = z.object({
  title: z.string().min(1).max(255).optional(),
  contactId: z.string().min(1).max(64).optional(),
  source: z.enum(['mic', 'tab', 'mic+tab']),
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

  const id = randomUUID();
  try {
    await db.insert(recordings).values({
      id,
      organizationId: orgId,
      userId: user.id,
      contactId: parsed.data.contactId ?? null,
      title: parsed.data.title ?? null,
      source: parsed.data.source,
      status: 'uploading',
      startedAt: new Date().toISOString(),
    });
    return NextResponse.json({ recordingId: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId, userId: user.id, err: msg }, 'recorder start failed');
    return NextResponse.json({ error: 'insert failed', detail: msg }, { status: 500 });
  }
}
