'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { TASK_CATALOG, parseResponsibilities } from '@/lib/enterprise/task-catalog';
import { syncRecurringTaskRouting } from '@/lib/enterprise/recurring-task-routing';

/**
 * Save the firm-wide DEFAULT responsibility matrix onto the enterprise org.
 * Access-checked via getCurrentEnterprise (the enterprise the user owns/staffs).
 * Clients inherit these unless they have a per-client override.
 */
export async function setEnterpriseDefaultResponsibilitiesAction(formData: FormData): Promise<void> {
  const real = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) throw new Error('forbidden');

  const defaults: Record<string, 'pro' | 'client'> = {};
  for (const t of TASK_CATALOG) {
    const v = String(formData.get(`resp_${t.key}`) ?? '');
    if (v === 'pro' || v === 'client') defaults[t.key] = v;
  }

  // Firm-wide default for who does the books. 'both' = the firm has a mix, so new
  // businesses aren't forced to a default (the pro chooses per business).
  const booksRaw = String(formData.get('defaultBooksManagedBy') ?? '');
  const defaultBooks = booksRaw === 'firm' || booksRaw === 'client' ? booksRaw : 'both';

  await db
    .update(organizations)
    .set({ enterpriseDefaultResponsibilities: defaults, enterpriseDefaultBooksManagedBy: defaultBooks })
    .where(eq(organizations.id, current.id));

  // Re-route every client's open recurring tasks to the new effective owner.
  // Inheriting clients pick up the new default; client-overridden tasks stay
  // (the override wins in resolveEffectiveOwner). Best-effort per client.
  const clientLinks = await db
    .select({ clientUserId: enterpriseClients.clientUserId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.enterpriseId, current.id));
  const clientUserIds = [...new Set(clientLinks.map((c) => c.clientUserId).filter(Boolean))];
  if (clientUserIds.length > 0) {
    const clientOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(inArray(organizations.ownerUserId, clientUserIds));
    for (const o of clientOrgs) {
      await syncRecurringTaskRouting(o.id, real.id).catch(() => 0);
    }
  }

  revalidatePath('/enterprise/settings');
  revalidatePath('/enterprise/dashboard');
  redirect('/enterprise/settings?saved=responsibilities');
}

/**
 * Drop one client's override for a task so it inherits the firm default again,
 * then re-route that client's open recurring tasks. Used by the "Client-specific
 * overrides" review panel when the firm decides a customized client should fall
 * back to the firm-wide default for a task.
 */
export async function applyFirmDefaultToClientAction(formData: FormData): Promise<void> {
  const real = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) throw new Error('forbidden');
  const orgId = String(formData.get('orgId') ?? '');
  const taskKey = String(formData.get('taskKey') ?? '');
  if (!orgId || !taskKey) throw new Error('orgId + taskKey required');

  const [org] = await db
    .select({ taskResponsibilities: organizations.taskResponsibilities, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Business not found');

  const [link] = await db
    .select({ id: enterpriseClients.id })
    .from(enterpriseClients)
    .where(and(eq(enterpriseClients.clientUserId, org.ownerUserId), eq(enterpriseClients.enterpriseId, current.id)))
    .limit(1);
  if (!link) throw new Error('forbidden');

  const overrides = parseResponsibilities(org.taskResponsibilities);
  delete overrides[taskKey];
  await db.update(organizations).set({ taskResponsibilities: overrides }).where(eq(organizations.id, orgId));
  await syncRecurringTaskRouting(orgId, real.id);

  revalidatePath('/enterprise/settings');
  revalidatePath('/enterprise/dashboard');
  redirect('/enterprise/settings');
}
