import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  getOutlook,
  isAllowedOutlookWindow,
  DEFAULT_OUTLOOK_WINDOW,
  type OutlookData,
} from '@/lib/server/outlook';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 15;

export type { OutlookData };

/**
 * GET /api/outlook?windowDays=N → OutlookData
 *
 * Auth pattern mirrors /api/ai/action-cards: requireSession before the try so
 * NEXT_REDIRECT propagates as a 307 instead of being swallowed into a 500.
 * Fresh accounts without an org get an empty (zeroed) outlook so the panel
 * paints a calm "no data yet" state rather than 500ing.
 */
export async function GET(req: NextRequest) {
  await requireSession();

  const raw = Number(new URL(req.url).searchParams.get('windowDays'));
  const windowDays = isAllowedOutlookWindow(raw) ? raw : DEFAULT_OUTLOOK_WINDOW;

  let orgId: string;
  try {
    orgId = await getCurrentOrgId();
  } catch (err) {
    if (err instanceof Error && err.message.includes('no organization assigned')) {
      return NextResponse.json(emptyOutlook(windowDays));
    }
    throw err;
  }

  try {
    const data = await getOutlook(orgId, windowDays);
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'outlook error';
    logger.error({ err: msg }, 'outlook GET failed');
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function emptyOutlook(windowDays: number): OutlookData {
  const zerosTrailing = Array(windowDays).fill(0);
  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    income: {
      actual: 0,
      projected: 0,
      projectedBreakdown: { scheduled: 0, extrapolated: null },
      trailing: zerosTrailing,
      projectedDaily: [],
      notEnoughHistory: true,
    },
    expenses: {
      actual: 0,
      projected: 0,
      projectedBreakdown: { scheduled: 0, extrapolated: null },
      trailing: zerosTrailing,
      projectedDaily: [],
      notEnoughHistory: true,
    },
    invoices: { actual: 0, projected: 0 },
    bills: { actual: 0, projected: 0 },
  };
}
