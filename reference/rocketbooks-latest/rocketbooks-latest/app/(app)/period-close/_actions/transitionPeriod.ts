'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { accountingPeriods, organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { recordFirmChange } from '@/lib/enterprise/attribution';
import { autoCompleteRecurringTasks } from '@/lib/enterprise/auto-complete-tasks';

export type PeriodStatus = 'open' | 'reviewed' | 'closed';
const VALID: PeriodStatus[] = ['open', 'reviewed', 'closed'];

export interface TransitionResult {
  ok: boolean;
  error?: string;
}

/**
 * Move an accounting month between open → reviewed → closed (and reopen back to
 * open). Owner/super-admin gated. Upserts one row per (org, year, month);
 * stamps reviewed/closed by+at; reopen clears the stamps.
 */
export async function transitionPeriod(year: number, month: number, to: PeriodStatus): Promise<TransitionResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  if (!VALID.includes(to)) return { ok: false, error: 'Invalid status' };
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) {
    return { ok: false, error: 'Invalid period' };
  }

  const [org] = await db
    .select({ owner: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const superAdmin = await isSuperAdmin();
  if (!org || (org.owner !== userId && !superAdmin)) {
    return { ok: false, error: 'Only the organization owner can change period status.' };
  }

  const now = new Date().toISOString();
  // Consistent-shape update; `undefined` means "leave as-is" (e.g. keep the
  // reviewed stamp when closing a month that was reviewed first).
  const set = {
    status: to,
    updatedAt: now,
    reviewedByUserId: to === 'reviewed' ? userId : to === 'open' ? null : undefined,
    reviewedAt: to === 'reviewed' ? now : to === 'open' ? null : undefined,
    closedByUserId: to === 'closed' ? userId : null,
    closedAt: to === 'closed' ? now : null,
  };

  await db
    .insert(accountingPeriods)
    .values({ id: randomUUID(), organizationId: orgId, year, month, createdAt: now, ...set })
    .onConflictDoUpdate({
      target: [accountingPeriods.organizationId, accountingPeriods.year, accountingPeriods.month],
      set,
    });

  const periodLabel = `${year}-${String(month).padStart(2, '0')}`;
  await recordFirmChange({
    action: `period_${to}`,
    orgId,
    entityType: 'period',
    entityId: periodLabel,
    summary: `Marked ${periodLabel} ${to}`,
  });

  // Instantly complete the month-end-close recurring task once its work is done,
  // rather than waiting for the daily sweep.
  if (to === 'reviewed' || to === 'closed') {
    await autoCompleteRecurringTasks(orgId).catch(() => 0);
    revalidatePath('/tasks');
    revalidatePath('/enterprise/work');
  }

  revalidatePath('/period-close');
  return { ok: true };
}
