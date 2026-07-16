import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { isDemoOrg } from '@/lib/auth/demo';
import { inboundConfigured } from '@/lib/email/inbound-token';
import { sendContactInquiry } from '@/lib/accounting/contact-inquiry';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Daily (13:00 UTC): for each opted-in org, email the client about recent
 * transactions whose contact is unknown so they can reply with who each is.
 * Opt-in (organizations.contact_inquiry_enabled) AND requires inbound email to
 * be configured (otherwise replies can't route back — the lib no-ops).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });
  if (!inboundConfigured()) {
    return NextResponse.json({ ok: true, skipped: 'inbound_not_configured' });
  }

  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.contactInquiryEnabled, true));

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || isDemoOrg(r.id)) continue;
    try {
      const res = await sendContactInquiry({ orgId: r.id });
      if (res.skipped) skipped++;
      else if (res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
      logger.error({ orgId: r.id, err: e instanceof Error ? e.message : String(e) }, 'contact-inquiries: org failed');
    }
  }

  logger.info({ sent, skipped, failed, total: rows.length }, 'contact-inquiries: done');
  return NextResponse.json({ ok: true, sent, skipped, failed });
}
