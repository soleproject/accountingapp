import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getActionCards, type ActionCard } from '@/lib/server/action-cards';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 15;

export type { ActionCard };

/**
 * GET /api/ai/action-cards → { cards: ActionCard[] }
 *
 * `requireSession` calls `redirect('/login')` for unauthed users — that throws
 * a NEXT_REDIRECT error which Next intercepts to emit a 307. Per Next docs,
 * redirect() must be called outside the try/catch or the catch will swallow
 * the redirect and turn it into a 500. So auth happens before the try.
 */
export async function GET() {
  await requireSession();

  // Fresh accounts (created but not yet attached to an org) hit this path
  // before they finish signup. Surface "all caught up" rather than 500 — the
  // panel has nothing to derive without an org and a 500 would make the
  // panel look broken to a user who's just early in their setup.
  let orgId: string;
  try {
    orgId = await getCurrentOrgId();
  } catch (err) {
    if (err instanceof Error && err.message.includes('no organization assigned')) {
      return NextResponse.json({ cards: [] });
    }
    throw err;
  }

  try {
    const cards = await getActionCards(orgId);
    return NextResponse.json({ cards });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'action-cards error';
    logger.error({ err: msg }, 'action-cards GET degraded');
    return NextResponse.json({ cards: [], degraded: true });
  }
}
