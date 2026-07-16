import { NextRequest, NextResponse } from 'next/server';
import { lt, or, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { plaidAccounts } from '@/db/schema/schema';
import { safeSend } from '@/lib/inngest';
import { isAuthorizedCron } from '@/lib/cron';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse('forbidden', { status: 401 });

  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const stale = await db
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .where(or(isNull(plaidAccounts.lastSyncedAt), lt(plaidAccounts.lastSyncedAt, fifteenMinAgo)));

  let sent = 0;
  for (const a of stale) {
    if (await safeSend({ name: 'plaid/sync.requested', data: { accountId: a.id, trigger: 'CRON_FALLBACK' } })) {
      sent++;
    }
  }

  logger.info({ count: stale.length, queued: sent }, 'plaid-sync-all fired');
  return NextResponse.json({ ok: true, queued: sent, stale: stale.length });
}
