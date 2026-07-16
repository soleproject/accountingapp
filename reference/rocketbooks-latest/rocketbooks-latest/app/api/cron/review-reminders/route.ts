import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { isDemoOrg } from '@/lib/auth/demo';
import { sendClientReviewRequest } from '@/lib/accounting/review-outreach';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/** Only auto-nudge when the client has a meaningful backlog (avoid nagging). */
const MIN_PENDING = 3;

/**
 * Weekly (Tue 09:00 UTC): for each opted-in org, nudge the client about
 * transactions waiting in their review queue. Opt-in only
 * (organizations.review_auto_outreach_enabled). The outreach lib enforces the
 * 24h per-org cooldown, so a re-run / weekly cadence won't spam.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.reviewAutoOutreachEnabled, true));

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || isDemoOrg(r.id)) continue;
    try {
      const res = await sendClientReviewRequest({ orgId: r.id, minPending: MIN_PENDING });
      if (res.skipped) skipped++;
      else if (res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
      logger.error({ orgId: r.id, err: e instanceof Error ? e.message : String(e) }, 'review-reminders: org failed');
    }
  }

  logger.info({ sent, skipped, failed, total: rows.length }, 'review-reminders: done');
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
