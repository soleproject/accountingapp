import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { isDemoOrg } from '@/lib/auth/demo';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Weekly fan-out (Mon 09:00 UTC): dispatch a digest for every org whose OWNER
 * has opted in (users.weekly_digest_opt_in_at IS NOT NULL). Per-org work +
 * email send happens in the `weekly-digest` Inngest job; this route enumerates
 * and emits. Opt-in only — orgs whose owner hasn't enabled it get nothing.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const rows = await db
    .select({ organizationId: organizations.id })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(isNotNull(users.weeklyDigestOptInAt), eq(users.isActive, true)));

  let dispatched = 0;
  for (const r of rows) {
    if (!r.organizationId || isDemoOrg(r.organizationId)) continue;
    await safeSend({
      name: 'digest/weekly.requested',
      data: { organizationId: r.organizationId, triggeredBy: 'cron' },
    });
    dispatched++;
  }

  logger.info({ dispatched }, 'alerts-weekly: dispatched weekly digests');
  return NextResponse.json({ ok: true, dispatched });
}
