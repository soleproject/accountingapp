import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createOrResumeSession, loadSessionView } from '@/lib/server/categorization-session';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * POST /api/categorization/session → { sessionId, contacts, ... }
 *
 * Creates a fresh session if none active, otherwise resumes the existing one.
 * Snapshot is captured at session-start; subsequently-added uncategorized
 * contacts won't appear (open a new session for those).
 */
export async function POST() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  try {
    const view = await createOrResumeSession({ organizationId: orgId, userId: user.id });
    return NextResponse.json(view);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'session error';
    logger.error({ err: msg }, 'POST /api/categorization/session failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/categorization/session?id=<sessionId> → SessionView
 *
 * Reload an existing session by id (used on browser refresh / deep link).
 */
export async function GET(req: Request) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const sessionId = new URL(req.url).searchParams.get('id');
  if (!sessionId) return NextResponse.json({ error: 'id required' }, { status: 400 });
  try {
    const view = await loadSessionView(sessionId, orgId);
    return NextResponse.json(view);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'session load error';
    if (msg === 'Session not found') return NextResponse.json({ error: msg }, { status: 404 });
    logger.error({ err: msg }, 'GET /api/categorization/session failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
