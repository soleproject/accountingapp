'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

const MAX_PER_BATCH = 200;

export interface TriggerAutoCategorizeState {
  ok?: boolean;
  queued?: number;
  remaining?: number;
  error?: string;
}

export async function triggerAutoCategorize(
  _prev: TriggerAutoCategorizeState | undefined,
): Promise<TriggerAutoCategorizeState | undefined> {
  const orgId = await getCurrentOrgId();

  // Find uncategorized = no journalEntryId yet (covers both "no category" and
  // "categorized but not posted" — auto-categorize handles both)
  const uncategorized = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.organizationId, orgId), isNull(transactions.journalEntryId)));

  if (uncategorized.length === 0) {
    return { ok: true, queued: 0, remaining: 0 };
  }

  const batch = uncategorized.slice(0, MAX_PER_BATCH).map((t) => t.id);
  const remaining = uncategorized.length - batch.length;

  const ok = await safeSend({
    name: 'transactions/auto-categorize.requested',
    data: { organizationId: orgId, transactionIds: batch },
  });

  logger.info({ orgId, queued: batch.length, remaining, queueOk: ok }, 'manual auto-categorize triggered');
  revalidatePath('/transactions');
  return ok
    ? { ok: true, queued: batch.length, remaining }
    : { ok: false, error: 'Background queue unavailable. Try again in a minute.' };
}
