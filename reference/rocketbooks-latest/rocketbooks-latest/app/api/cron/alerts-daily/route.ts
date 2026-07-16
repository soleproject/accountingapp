import { NextRequest, NextResponse } from 'next/server';
import { isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { isAuthorizedCron } from '@/lib/cron';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

/**
 * Daily fan-out: dispatch a books-correctness audit sweep for every org that
 * has any transactions. The heavy lifting (duplicate re-scan + integrity sweep)
 * runs in the per-org Inngest `audit-sweep` job; this route just enumerates and
 * emits. Findings land in book_review_findings and surface on the action-card
 * worklist + /book-review queue.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const orgs = await db
    .selectDistinct({ organizationId: transactions.organizationId })
    .from(transactions)
    .where(isNotNull(transactions.organizationId));

  let dispatched = 0;
  for (const o of orgs) {
    if (!o.organizationId) continue;
    await safeSend({
      name: 'audit/sweep.requested',
      data: { organizationId: o.organizationId, triggeredBy: 'cron' },
    });
    dispatched++;
  }

  logger.info({ dispatched }, 'alerts-daily: dispatched audit sweeps');
  return NextResponse.json({ ok: true, dispatched });
}
