import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  applySessionContact,
  loadSessionView,
  skipSessionContact,
  unskipSessionContact,
} from '@/lib/server/categorization-session';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    sessionId: z.string().min(1),
    accountIdCandidate: z.string().min(1),
    source: z.enum(['rules', 'ai', 'manual']).default('manual'),
  }),
  z.object({
    action: z.literal('skip'),
    sessionId: z.string().min(1),
  }),
  z.object({
    action: z.literal('unskip'),
    sessionId: z.string().min(1),
  }),
]);

/**
 * POST /api/categorization/contact/<sessionContactId>
 *   body: { action: 'apply' | 'skip' | 'unskip', sessionId, ... }
 *
 * Direct button paths from the workspace. The AI intent path (POST
 * /api/categorization/intent) ultimately calls the same helpers but routes
 * a parsed message through the parser first.
 *
 * Returns the full session view after the mutation so the UI can re-render
 * the entire table state in one round-trip.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ sessionContactId: string }> },
) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { sessionContactId } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  try {
    if (parsed.data.action === 'apply') {
      const result = await applySessionContact({
        organizationId: orgId,
        sessionId: parsed.data.sessionId,
        sessionContactId,
        accountIdCandidate: parsed.data.accountIdCandidate,
        source: parsed.data.source,
      });
      const view = await loadSessionView(parsed.data.sessionId, orgId);
      return NextResponse.json({ result, session: view });
    }
    if (parsed.data.action === 'skip') {
      await skipSessionContact({ sessionId: parsed.data.sessionId, sessionContactId });
      const view = await loadSessionView(parsed.data.sessionId, orgId);
      return NextResponse.json({ result: { ok: true }, session: view });
    }
    if (parsed.data.action === 'unskip') {
      await unskipSessionContact({ sessionId: parsed.data.sessionId, sessionContactId });
      const view = await loadSessionView(parsed.data.sessionId, orgId);
      return NextResponse.json({ result: { ok: true }, session: view });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'contact action error';
    logger.error({ err: msg, sessionContactId }, 'POST /api/categorization/contact failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ error: 'unhandled' }, { status: 500 });
}
