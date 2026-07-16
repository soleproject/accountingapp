import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, tasks, enterpriseClients } from '@/db/schema/schema';
import {
  TASK_CATALOG,
  SIGNAL_COVERED_TASK_KEYS,
  resolveEffectiveOwner,
  parseResponsibilities,
  type TaskCadence,
} from '@/lib/enterprise/task-catalog';
import { getEnterpriseDefaultsForOwner } from '@/lib/enterprise/recurring-task-routing';

// One generated task is tagged so we can (a) dedup re-runs and (b) keep the
// firm's internal work out of the client's task list. entity_type marks it as a
// generated recurring task; entity_id = "<catalogKey>:<period>" is the dedup key
// per org; category = 'firm' | 'client' marks the audience; source = 'recurring'.
const RECURRING_ENTITY_TYPE = 'recurring_task';
export const RECURRING_SOURCE = 'recurring';
export const FIRM_CATEGORY = 'firm';
export const CLIENT_CATEGORY = 'client';

interface PeriodInfo {
  period: string;
  due: Date;
}

function lastDayOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex + 1, 0);
}

/** The current monthly / quarterly / annual periods + their due dates. */
export function currentPeriods(now: Date): Record<TaskCadence, PeriodInfo> {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  const q = Math.floor(m / 3); // 0..3
  const qEndMonth = q * 3 + 2;
  return {
    monthly: { period: `${y}-${String(m + 1).padStart(2, '0')}`, due: lastDayOfMonth(y, m) },
    quarterly: { period: `${y}-Q${q + 1}`, due: lastDayOfMonth(y, qEndMonth) },
    annual: { period: `${y}`, due: new Date(y, 11, 31) },
  };
}

export interface GenerateResult {
  created: number;
  skipped: number;
  firm: number;
  client: number;
}

/**
 * Generate the current period's recurring tasks for one client business from its
 * responsibility matrix. Pro-owned tasks are assigned to `firmUserId` and tagged
 * category='firm'; client-owned tasks are assigned to the business owner and
 * tagged category='client'. Idempotent: a (catalogKey, period) already present
 * for the org is skipped, so re-running never duplicates.
 */
export async function generateRecurringTasks(
  orgId: string,
  opts: { firmUserId?: string; now?: Date } = {},
): Promise<GenerateResult> {
  const [org] = await db
    .select({
      ownerUserId: organizations.ownerUserId,
      taskResponsibilities: organizations.taskResponsibilities,
      booksManagedBy: organizations.booksManagedBy,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Business not found');

  const responsibilities = parseResponsibilities(org.taskResponsibilities);
  const enterpriseDefaults = parseResponsibilities(await getEnterpriseDefaultsForOwner(org.ownerUserId));
  const booksManagedBy = org.booksManagedBy === 'firm' ? 'firm' : 'client';
  const periods = currentPeriods(opts.now ?? new Date());

  // Who owns pro tasks: the explicit firmUserId (on-demand action) or the
  // enterprise owner for this client (cron, no acting user). Falls back to the
  // org owner so a row always has a valid assignee.
  let firmUserId = opts.firmUserId;
  if (!firmUserId) {
    const [link] = await db
      .select({ enterpriseId: enterpriseClients.enterpriseId })
      .from(enterpriseClients)
      .where(eq(enterpriseClients.clientUserId, org.ownerUserId))
      .limit(1);
    if (link) {
      const [ent] = await db
        .select({ ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, link.enterpriseId))
        .limit(1);
      firmUserId = ent?.ownerUserId ?? undefined;
    }
  }
  if (!firmUserId) firmUserId = org.ownerUserId;

  const result: GenerateResult = { created: 0, skipped: 0, firm: 0, client: 0 };

  for (const task of TASK_CATALOG) {
    // Skip tasks already covered by a live dashboard signal — the signal is the
    // detailed, self-clearing work item, so a generic recurring task would dupe.
    if (SIGNAL_COVERED_TASK_KEYS.has(task.key)) continue;

    const { period, due } = periods[task.cadence];
    const entityId = `${task.key}:${period}`;

    const [exists] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, orgId),
          eq(tasks.entityType, RECURRING_ENTITY_TYPE),
          eq(tasks.entityId, entityId),
        ),
      )
      .limit(1);
    if (exists) {
      result.skipped += 1;
      continue;
    }

    const owner = resolveEffectiveOwner(task, responsibilities, enterpriseDefaults, booksManagedBy);
    const isFirm = owner === 'pro';
    const assigneeId = isFirm ? firmUserId : org.ownerUserId;

    await db.insert(tasks).values({
      id: randomUUID(),
      userId: assigneeId,
      organizationId: orgId,
      product: 'accounting',
      page: '/tasks',
      entityType: RECURRING_ENTITY_TYPE,
      entityId,
      title: task.label,
      description: task.description,
      module: 'recurring',
      category: isFirm ? FIRM_CATEGORY : CLIENT_CATEGORY,
      status: 'OPEN',
      source: RECURRING_SOURCE,
      autoCreated: true,
      reviewRequired: false,
      dueDate: due.toISOString(),
      assignedToUsers: [assigneeId],
      assignedToContacts: [],
      subitems: [],
    });

    result.created += 1;
    if (isFirm) result.firm += 1;
    else result.client += 1;
  }

  // When the CLIENT owns "Categorize & review" (they keep their own books), the pro's
  // monthly job is a high-level OVERVIEW of the client's categorization work — not
  // per-transaction review. It's not a catalog task (it's conditional on that one
  // responsibility), so emit it here as a FIRM recurring task → lands on
  // /enterprise/work and the Pro Attention tab. Same dedup + firm assignment.
  const categorizeTask = TASK_CATALOG.find((t) => t.key === 'categorize_transactions');
  if (categorizeTask) {
    const categorizeOwner = resolveEffectiveOwner(categorizeTask, responsibilities, enterpriseDefaults, booksManagedBy);
    if (categorizeOwner === 'client') {
      const { period, due } = periods.monthly;
      const entityId = `categorize_overview:${period}`;
      const [exists] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.organizationId, orgId),
            eq(tasks.entityType, RECURRING_ENTITY_TYPE),
            eq(tasks.entityId, entityId),
          ),
        )
        .limit(1);
      if (exists) {
        result.skipped += 1;
      } else {
        await db.insert(tasks).values({
          id: randomUUID(),
          userId: firmUserId,
          organizationId: orgId,
          product: 'accounting',
          page: '/tasks',
          entityType: RECURRING_ENTITY_TYPE,
          entityId,
          title: 'Monthly overview — review categorizations',
          description: "Client keeps the books — give the month's categorizations a high-level review.",
          module: 'recurring',
          category: FIRM_CATEGORY,
          status: 'OPEN',
          source: RECURRING_SOURCE,
          autoCreated: true,
          reviewRequired: false,
          dueDate: due.toISOString(),
          assignedToUsers: [firmUserId],
          assignedToContacts: [],
          subitems: [],
        });
        result.created += 1;
        result.firm += 1;
      }
    }
  }

  return result;
}
