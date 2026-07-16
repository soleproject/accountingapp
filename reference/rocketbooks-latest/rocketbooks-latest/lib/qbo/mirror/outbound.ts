import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { items, qboConnections, qboEntityMap, qboOutboundQueue } from '@/db/schema/schema';
import { canMirrorQbo } from '@/lib/billing/entitlements';
import { isEntityEnabled, loadMirrorSettings, type EntityKind } from './settings';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OutboundOperation = 'create' | 'update' | 'delete';

export interface EnqueueArgs {
  organizationId: string;
  entityType: EntityKind;
  localId: string;
  operation: OutboundOperation;
  /**
   * Pre-serialized QBO body. The drain worker augments with Id + SyncToken
   * for updates from the entity_map at process time, so SyncToken should
   * NOT be included here.
   */
  payload: Record<string, unknown>;
}

/**
 * Insert a row into qbo_outbound_queue WITHIN the caller's transaction so
 * the enqueue commits atomically with the local write. Returns the queue
 * row id, or null when outbound is not active (no connection, not
 * entitled, entity disabled in mirror settings) — caller treats that as a
 * silent skip.
 *
 * The qbo/outbound.enqueued event is fired AFTER the caller commits;
 * callers should pass the returned id to a separate fire-and-forget step
 * outside the transaction. Firing inside the tx would leak: a rollback
 * would leave the event already in flight.
 */
export async function enqueueOutbound(tx: Tx, args: EnqueueArgs): Promise<string | null> {
  if (!(await canMirrorQbo(args.organizationId))) return null;

  // Resolve realm from the (org → connection) join. An org without an
  // active connection has nothing to push to; skip silently.
  const [connection] = await tx
    .select({ realmId: qboConnections.realmId })
    .from(qboConnections)
    .where(eq(qboConnections.orgId, args.organizationId))
    .limit(1);
  if (!connection) return null;

  const settings = await loadMirrorSettings(args.organizationId, connection.realmId);
  if (!isEntityEnabled(settings, args.entityType)) return null;

  const id = randomUUID();
  const now = new Date().toISOString();
  await tx.insert(qboOutboundQueue).values({
    id,
    organizationId: args.organizationId,
    realmId: connection.realmId,
    entityType: args.entityType,
    localId: args.localId,
    operation: args.operation,
    payload: args.payload as unknown as Record<string, unknown>,
    status: 'pending',
    attempts: 0,
    scheduledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/**
 * Fire the Inngest event that wakes the drain worker. Call AFTER the
 * enclosing transaction commits — see enqueueOutbound docstring. Safe to
 * call with [] (no-op).
 */
export async function fireOutboundDrain(queueIds: string[]): Promise<void> {
  if (queueIds.length === 0) return;
  await safeSend({
    name: 'qbo/outbound.enqueued',
    data: { queueIds },
  });
}

/**
 * Convenience wrapper: open a single-shot enqueue (no other writes), then
 * fire the drain event. For cases where the local write happened in its
 * own transaction and the enqueue is a follow-up — but PREFER the explicit
 * (tx, fire-after-commit) pattern when you can.
 */
export async function enqueueOutboundStandalone(args: EnqueueArgs): Promise<string | null> {
  const id = await db.transaction(async (tx) => enqueueOutbound(tx, args));
  if (id) {
    logger.debug({ id, entityType: args.entityType, op: args.operation }, 'qbo outbound enqueued (standalone)');
    await fireOutboundDrain([id]);
  }
  return id;
}

/**
 * Look up the QBO id for a local id. Returns null when no mapping exists
 * yet — server actions use this to decide whether to enqueue (vendor is
 * mapped → push the bill) or skip (vendor unmapped → wait for inbound /
 * its own outbound to land first). Reads via the passed tx so the lookup
 * sees uncommitted writes from the same transaction.
 */
export async function resolveQboId(
  txOrDb: Tx | typeof db,
  organizationId: string,
  entityType: string,
  localId: string,
): Promise<string | null> {
  const [row] = await txOrDb
    .select({ qboId: qboEntityMap.qboId })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, organizationId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.localId, localId),
    ))
    .limit(1);
  return row?.qboId ?? null;
}

/**
 * Best-effort item-QBO-id picker for an invoice line. QBO Invoice lines
 * require ItemRef but RocketSuite's invoice_lines schema doesn't track an
 * item id — only a revenue account. Heuristic:
 *
 *   1. Item with incomeAccountId === revenueAccountId AND a QBO mapping
 *   2. Any item in this org with a QBO mapping (so the push doesn't fail)
 *   3. null when the org has no mapped items at all
 *
 * Returns the QBO Item id. Caller bails out of enqueue when null.
 */
export async function pickItemQboIdForRevenueAccount(
  txOrDb: Tx | typeof db,
  organizationId: string,
  revenueAccountId: string,
): Promise<string | null> {
  // Items whose incomeAccountId matches, joined with their QBO mapping.
  const matched = await txOrDb
    .select({ qboId: qboEntityMap.qboId })
    .from(items)
    .innerJoin(qboEntityMap, and(
      eq(qboEntityMap.entityType, 'item'),
      eq(qboEntityMap.localId, items.id),
    ))
    .where(and(
      eq(items.organizationId, organizationId),
      eq(items.incomeAccountId, revenueAccountId),
      eq(items.isActive, true),
    ))
    .limit(1);
  if (matched[0]?.qboId) return matched[0].qboId;
  // Fallback: any mapped active item in the org.
  const anyItem = await txOrDb
    .select({ qboId: qboEntityMap.qboId })
    .from(items)
    .innerJoin(qboEntityMap, and(
      eq(qboEntityMap.entityType, 'item'),
      eq(qboEntityMap.localId, items.id),
    ))
    .where(and(
      eq(items.organizationId, organizationId),
      eq(items.isActive, true),
    ))
    .limit(1);
  return anyItem[0]?.qboId ?? null;
}

/**
 * Pop the next pending row using FOR UPDATE SKIP LOCKED so concurrent
 * drain runs don't double-process. Returns null when the queue is empty
 * or all rows are locked by another worker.
 */
export async function claimNextOutboundRow(realmId: string): Promise<typeof qboOutboundQueue.$inferSelect | null> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(qboOutboundQueue)
      .where(sql`${qboOutboundQueue.realmId} = ${realmId}
                 AND ${qboOutboundQueue.status} = 'pending'
                 AND ${qboOutboundQueue.scheduledAt} <= now()`)
      .orderBy(qboOutboundQueue.scheduledAt)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    await tx
      .update(qboOutboundQueue)
      .set({ status: 'running', attempts: row.attempts + 1, updatedAt: new Date().toISOString() })
      .where(eq(qboOutboundQueue.id, row.id));
    return { ...row, status: 'running', attempts: row.attempts + 1 };
  });
}

export async function markOutboundCompleted(id: string, qboId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(qboOutboundQueue)
    .set({ status: 'completed', qboId, completedAt: now, lastError: null, updatedAt: now })
    .where(eq(qboOutboundQueue.id, id));
}

export async function markOutboundFailed(id: string, error: string, retryDelayMs: number | null): Promise<void> {
  const now = new Date().toISOString();
  const scheduledAt = retryDelayMs === null ? null : new Date(Date.now() + retryDelayMs).toISOString();
  await db
    .update(qboOutboundQueue)
    .set({
      status: retryDelayMs === null ? 'failed' : 'pending',
      lastError: error.slice(0, 500),
      scheduledAt: scheduledAt ?? undefined,
      updatedAt: now,
    })
    .where(eq(qboOutboundQueue.id, id));
}

