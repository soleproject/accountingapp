import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, organizations } from '@/db/schema/schema';

const PRODUCT = 'reconciliation';
const ENTITY_TYPE = 'reconciliation_period';

/** Owner user to assign a cron-triggered needs-attention task to. */
export async function resolveOrgOwnerUserId(organizationId: string): Promise<string | null> {
  const [o] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return o?.ownerUserId ?? null;
}

/**
 * Create or update the single OPEN "needs attention" task for a reconciliation
 * period (idempotent on product/entityType/entityId). Backed by the partial
 * unique index from migration 0102.
 */
export async function upsertReconciliationTask(args: {
  organizationId: string;
  userId: string;
  periodId: string;
  accountName: string;
  difference: number | null;
  explanation: string;
}): Promise<void> {
  const title =
    args.difference != null && Math.abs(args.difference) >= 0.01
      ? `Reconciliation off by $${Math.abs(args.difference).toFixed(2)} — ${args.accountName}`
      : `Reconciliation needs review — ${args.accountName}`;
  const now = new Date().toISOString();

  const [existing] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.product, PRODUCT),
        eq(tasks.entityType, ENTITY_TYPE),
        eq(tasks.entityId, args.periodId),
        eq(tasks.status, 'OPEN'),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(tasks)
      .set({ title, description: args.explanation || null, updatedAt: now })
      .where(eq(tasks.id, existing.id));
    return;
  }

  await db.insert(tasks).values({
    id: randomUUID(),
    userId: args.userId,
    organizationId: args.organizationId,
    product: PRODUCT,
    entityType: ENTITY_TYPE,
    entityId: args.periodId,
    page: `/reconciliation/${args.periodId}`,
    title,
    description: args.explanation || null,
    priority: 'high',
    status: 'OPEN',
    source: 'reconciliation-engine',
    autoCreated: true,
    reviewRequired: true,
    createdAt: now,
    updatedAt: now,
  });
}

/** Close the OPEN needs-attention task for a period once it reconciles. */
export async function resolveReconciliationTask(periodId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: 'DONE', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(tasks.product, PRODUCT),
        eq(tasks.entityType, ENTITY_TYPE),
        eq(tasks.entityId, periodId),
        eq(tasks.status, 'OPEN'),
      ),
    );
}
