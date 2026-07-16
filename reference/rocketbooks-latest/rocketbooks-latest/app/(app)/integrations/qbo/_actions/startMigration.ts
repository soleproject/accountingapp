'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { isDemoOrg } from '@/lib/auth/demo';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export interface StartMigrationResult {
  ok: boolean;
  error?: string;
}

/**
 * Manually (re-)trigger the historical QBO migration for the current org.
 *
 * Recovery path for the case where the automatic kick-off in the OAuth
 * callback never queued (Inngest outage / missing event key) — safeSend there
 * swallows the failure, so without this button a user is stuck on a "connected"
 * page with no migration and no way to retry short of disconnect/reconnect.
 *
 * Idempotent enough to call repeatedly: the Inngest function is concurrency-
 * limited to one run per org, and the promote phase is idempotent via
 * qboEntityMap, so a duplicate trigger is a no-op rather than a double import.
 */
export async function startMigration(): Promise<StartMigrationResult> {
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    return { ok: false, error: "QuickBooks isn't available in the demo workspace." };
  }

  const userId = await getEffectiveUserId();

  const [connection] = await db
    .select({ realmId: qboConnections.realmId })
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);
  if (!connection) {
    return { ok: false, error: 'Connect QuickBooks first.' };
  }

  const queued = await safeSend({
    name: 'qbo/migration.requested',
    data: { organizationId: orgId, realmId: connection.realmId, userId },
  });
  if (!queued) {
    logger.error({ orgId, realmId: connection.realmId }, 'manual qbo migration retrigger failed to queue');
    return { ok: false, error: 'Could not start the migration — the job queue is unavailable. Try again shortly.' };
  }

  logger.info({ orgId, realmId: connection.realmId }, 'qbo migration manually (re)triggered');
  revalidatePath('/integrations/qbo');
  return { ok: true };
}
