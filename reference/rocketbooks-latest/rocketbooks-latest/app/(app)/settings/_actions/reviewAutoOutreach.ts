'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

export interface SetReviewAutoOutreachResult {
  ok: boolean;
  error?: string;
}

/**
 * Org-level automatic review reminders (migration 0122). Accountant-gated; the
 * weekly review-reminders cron reads this on its next tick.
 */
export async function setReviewAutoOutreach(enabled: boolean): Promise<SetReviewAutoOutreachResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  await db.update(organizations).set({ reviewAutoOutreachEnabled: enabled }).where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  return { ok: true };
}
