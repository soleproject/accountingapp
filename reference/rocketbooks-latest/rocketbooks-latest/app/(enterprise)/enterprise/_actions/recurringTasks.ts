'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients, enterpriseStaff, tasks } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { generateRecurringTasks } from '@/lib/enterprise/recurring-tasks';

/** Throws 'forbidden' unless the signed-in user owns/staffs an enterprise that
 *  has `ownerUserId` as a client. */
async function requireFirmAccessToClientOwner(realUserId: string, ownerUserId: string): Promise<void> {
  const [owned, staffed] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, realUserId)),
    db.select({ id: enterpriseStaff.enterpriseId }).from(enterpriseStaff).where(eq(enterpriseStaff.staffUserId, realUserId)),
  ]);
  const enterpriseIds = Array.from(new Set([...owned.map((o) => o.id), ...staffed.map((s) => s.id)]));
  if (enterpriseIds.length === 0) throw new Error('forbidden');
  const [link] = await db
    .select({ id: enterpriseClients.id })
    .from(enterpriseClients)
    .where(and(eq(enterpriseClients.clientUserId, ownerUserId), inArray(enterpriseClients.enterpriseId, enterpriseIds)))
    .limit(1);
  if (!link) throw new Error('forbidden');
}

/**
 * Generate the current period's recurring tasks for a client business from its
 * responsibility matrix (firm tasks → the acting firm user, client tasks → the
 * business owner). Firm-access-checked through the org's owner. Idempotent.
 */
export async function generateRecurringTasksAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  if (!orgId) throw new Error('orgId required');
  const real = await requireSession();

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Business not found');

  await requireFirmAccessToClientOwner(real.id, org.ownerUserId);

  const res = await generateRecurringTasks(orgId, { firmUserId: real.id });

  revalidatePath(`/enterprise/businesses/${orgId}/edit`);
  revalidatePath('/enterprise/dashboard');
  redirect(
    `/enterprise/businesses/${orgId}/edit?generated=${res.created}&firm=${res.firm}&client=${res.client}&skipped=${res.skipped}`,
  );
}

/**
 * Mark a firm-owned recurring task done (or reopen it) from the enterprise Work
 * queue. Only operates on recurring firm tasks; firm-access-checked through the
 * task's client org.
 */
export async function setFirmTaskStatusAction(formData: FormData): Promise<void> {
  const taskId = String(formData.get('taskId') ?? '');
  if (!taskId) throw new Error('taskId required');
  const next = String(formData.get('status') ?? '') === 'DONE' ? 'DONE' : 'OPEN';
  const real = await requireSession();

  const [task] = await db
    .select({ organizationId: tasks.organizationId, source: tasks.source, category: tasks.category })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task || !task.organizationId) throw new Error('Task not found');
  if (task.source !== 'recurring' || task.category !== 'firm') throw new Error('forbidden');

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, task.organizationId))
    .limit(1);
  if (!org) throw new Error('forbidden');
  await requireFirmAccessToClientOwner(real.id, org.ownerUserId);

  await db.update(tasks).set({ status: next, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId));
  revalidatePath('/enterprise/work');
}
