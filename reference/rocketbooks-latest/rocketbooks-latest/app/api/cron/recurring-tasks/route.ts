import { NextRequest, NextResponse } from 'next/server';
import { isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { generateRecurringTasks } from '@/lib/enterprise/recurring-tasks';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Monthly: generate the current period's recurring tasks for every client
 * business that has a responsibility matrix set. The generator creates the
 * current month + quarter + year tasks and is idempotent (dedup per
 * task+period), so one monthly run covers all cadences — quarter/year tasks are
 * created on the first run of each quarter/year and skipped afterward. Done
 * directly (not Inngest) to avoid the app-sync trap; org counts are small.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNotNull(organizations.taskResponsibilities));

  let processed = 0;
  let created = 0;
  let failed = 0;
  for (const o of orgs) {
    try {
      const res = await generateRecurringTasks(o.id);
      created += res.created;
      processed += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        { orgId: o.id, err: err instanceof Error ? err.message : String(err) },
        'recurring-tasks cron: org failed',
      );
    }
  }

  logger.info({ orgs: orgs.length, processed, created, failed }, 'recurring-tasks cron: done');
  return NextResponse.json({ ok: true, orgs: orgs.length, processed, created, failed });
}
