import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { isDemoOrg } from '@/lib/auth/demo';
import { sendMonthlyReport } from '@/lib/reports/monthly-report';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Monthly (1st, 08:00 UTC): email each opted-in org's client a prior-month
 * financial snapshot. Opt-in only (organizations.monthly_report_enabled). The
 * lib dedups per period, so a re-run is safe.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.monthlyReportEnabled, true));

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || isDemoOrg(r.id)) continue;
    try {
      const res = await sendMonthlyReport({ orgId: r.id });
      if (res.skipped) skipped++;
      else if (res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
      logger.error({ orgId: r.id, err: e instanceof Error ? e.message : String(e) }, 'monthly-reports: org failed');
    }
  }

  logger.info({ sent, skipped, failed, total: rows.length }, 'monthly-reports: done');
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
