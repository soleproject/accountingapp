import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { isDemoOrg } from '@/lib/auth/demo';
import { inboundConfigured } from '@/lib/email/inbound-token';
import { sendSubstantiationRequest } from '@/lib/accounting/substantiation-outreach';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Weekly (Thu 09:00 UTC): for each opted-in org, email the client for IRS
 * documentation on recent substantiation-required transactions. Opt-in
 * (organizations.substantiation_enabled) AND requires inbound email configured.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });
  if (!inboundConfigured()) return NextResponse.json({ ok: true, skipped: 'inbound_not_configured' });

  const rows = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.substantiationEnabled, true));

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || isDemoOrg(r.id)) continue;
    try {
      const res = await sendSubstantiationRequest({ orgId: r.id });
      if (res.skipped) skipped++;
      else if (res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
      logger.error({ orgId: r.id, err: e instanceof Error ? e.message : String(e) }, 'substantiation-requests: org failed');
    }
  }

  logger.info({ sent, skipped, failed, total: rows.length }, 'substantiation-requests: done');
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
