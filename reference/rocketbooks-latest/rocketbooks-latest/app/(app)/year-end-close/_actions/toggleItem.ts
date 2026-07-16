'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { yearEndCloseItems } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

/** Check/uncheck a manual year-end-close item for the org + year. Accountant-gated. */
export async function toggleCloseItem(formData: FormData): Promise<void> {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(['accounting.transactions.accountant_review', 'enterprise.dashboard.view', 'enterprise.clients.view']))) return;

  const itemKey = String(formData.get('itemKey') ?? '').trim();
  const year = Number(formData.get('year'));
  const done = String(formData.get('done') ?? '') === 'true';
  if (!itemKey || !Number.isInteger(year)) return;

  const now = new Date().toISOString();
  await db
    .insert(yearEndCloseItems)
    .values({ id: randomUUID(), organizationId: orgId, year, itemKey, done, doneAt: done ? now : null, doneByUserId: done ? user.id : null, updatedAt: now })
    .onConflictDoUpdate({
      target: [yearEndCloseItems.organizationId, yearEndCloseItems.year, yearEndCloseItems.itemKey],
      set: { done, doneAt: done ? now : null, doneByUserId: done ? user.id : null, updatedAt: now },
    });

  revalidatePath('/year-end-close');
}
