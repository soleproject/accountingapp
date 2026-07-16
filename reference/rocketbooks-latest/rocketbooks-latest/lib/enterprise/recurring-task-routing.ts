import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, tasks, enterpriseClients } from '@/db/schema/schema';
import { TASK_CATALOG, resolveEffectiveOwner, parseResponsibilities } from '@/lib/enterprise/task-catalog';

const FIRM_CATEGORY = 'firm';
const CLIENT_CATEGORY = 'client';

/** The enterprise-wide default matrix for the enterprise this client belongs to. */
export async function getEnterpriseDefaultsForOwner(ownerUserId: string): Promise<unknown> {
  const [link] = await db
    .select({ enterpriseId: enterpriseClients.enterpriseId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.clientUserId, ownerUserId))
    .limit(1);
  if (!link) return null;
  const [ent] = await db
    .select({ d: organizations.enterpriseDefaultResponsibilities })
    .from(organizations)
    .where(eq(organizations.id, link.enterpriseId))
    .limit(1);
  return ent?.d ?? null;
}

/**
 * Re-route an org's OPEN recurring tasks to their CURRENT effective owner —
 * updates category ('firm'/'client') + assignee. Call after responsibilities
 * change (per-client override or enterprise default) so the Work queue and the
 * client's task list match the dashboard (which already re-resolves live).
 * `firmUserId` is the assignee for pro-owned tasks. Returns how many moved.
 */
export async function syncRecurringTaskRouting(orgId: string, firmUserId: string): Promise<number> {
  const [org] = await db
    .select({
      ownerUserId: organizations.ownerUserId,
      taskResponsibilities: organizations.taskResponsibilities,
      booksManagedBy: organizations.booksManagedBy,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return 0;

  const clientMatrix = parseResponsibilities(org.taskResponsibilities);
  const entDefaults = parseResponsibilities(await getEnterpriseDefaultsForOwner(org.ownerUserId));
  const booksManagedBy =
    org.booksManagedBy === 'firm' || org.booksManagedBy === 'client' ? org.booksManagedBy : null;

  const open = await db
    .select({ id: tasks.id, entityId: tasks.entityId, category: tasks.category })
    .from(tasks)
    .where(and(eq(tasks.organizationId, orgId), eq(tasks.source, 'recurring'), eq(tasks.status, 'OPEN')));

  let updated = 0;
  for (const t of open) {
    const key = (t.entityId ?? '').split(':')[0];
    const task = TASK_CATALOG.find((ct) => ct.key === key);
    if (!task) continue;
    const owner = resolveEffectiveOwner(task, clientMatrix, entDefaults, booksManagedBy);
    const cat = owner === 'pro' ? FIRM_CATEGORY : CLIENT_CATEGORY;
    if (t.category !== cat) {
      const assignee = owner === 'pro' ? firmUserId : org.ownerUserId;
      await db
        .update(tasks)
        .set({ category: cat, userId: assignee, assignedToUsers: [assignee] })
        .where(eq(tasks.id, t.id));
      updated += 1;
    }
  }
  return updated;
}
