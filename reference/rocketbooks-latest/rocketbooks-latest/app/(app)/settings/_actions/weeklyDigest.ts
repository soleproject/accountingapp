'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface SetWeeklyDigestResult {
  ok: boolean;
  error?: string;
}

/**
 * Per-user opt-in for the proactive weekly digest email (migration 0116).
 * Owner-only feature, opt-in: nothing is sent until this is enabled. Clearing
 * it (here or via the unsubscribe link) stops the digest.
 */
export async function setWeeklyDigestOptIn(enabled: boolean): Promise<SetWeeklyDigestResult> {
  await requireSession();
  const userId = await getEffectiveUserId();
  await db
    .update(users)
    .set({ weeklyDigestOptInAt: enabled ? new Date().toISOString() : null })
    .where(eq(users.id, userId));
  revalidatePath('/settings');
  return { ok: true };
}
