import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConflicts, qboEntityMap } from '@/db/schema/schema';
import { logger } from '@/lib/logger';

/**
 * Read the qbo_entity_map row for (org, realm, entity, qbo id). Returns null
 * when no mapping exists (typical for a webhook about a record created in
 * QBO after the initial migration — the upserter will then create one).
 */
export async function loadEntityMap(
  organizationId: string,
  realmId: string,
  entityType: string,
  qboId: string,
): Promise<typeof qboEntityMap.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, organizationId),
      eq(qboEntityMap.realmId, realmId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.qboId, qboId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * A conflict exists when BOTH sides have changed a record since the last
 * sync. We detect it by comparing:
 *
 *   - QBO's MetaData.LastUpdatedTime (the inbound timestamp) vs
 *     map.lastQboUpdatedAt (the value when we last synced)
 *   - map.lastLocalUpdatedAt vs map.lastSyncAt — local edits ride the
 *     outbound writer, which bumps lastLocalUpdatedAt; lastSyncAt is set
 *     only when the outbound push succeeds. If lastLocalUpdatedAt is newer
 *     than lastSyncAt, the local change hasn't been pushed yet.
 *
 * When both conditions hold, the inbound update would clobber a pending
 * local change. Write a qbo_conflicts row and let the user decide.
 */
export function detectConflict(
  map: typeof qboEntityMap.$inferSelect,
  inboundLastUpdated: string,
): boolean {
  const inboundChanged = !map.lastQboUpdatedAt ||
    new Date(inboundLastUpdated).getTime() > new Date(map.lastQboUpdatedAt).getTime();
  if (!inboundChanged) return false;

  if (!map.lastLocalUpdatedAt) return false;
  const localUnpushed = !map.lastSyncAt ||
    new Date(map.lastLocalUpdatedAt).getTime() > new Date(map.lastSyncAt).getTime();
  return localUnpushed;
}

export async function writeConflict(args: {
  organizationId: string;
  entityMapId: string;
  qboSnapshot: Record<string, unknown>;
  localSnapshot: Record<string, unknown>;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(qboConflicts).values({
    id: randomUUID(),
    entityMapId: args.entityMapId,
    organizationId: args.organizationId,
    detectedAt: now,
    qboSnapshot: args.qboSnapshot,
    localSnapshot: args.localSnapshot,
    createdAt: now,
    updatedAt: now,
  });
  // Flag the map row so the outbound worker won't re-push the local
  // change underneath the user's resolution choice. Reset to 'synced'
  // when the user resolves.
  await db
    .update(qboEntityMap)
    .set({ syncStatus: 'conflict', updatedAt: now })
    .where(eq(qboEntityMap.id, args.entityMapId));
  logger.warn({ entityMapId: args.entityMapId, orgId: args.organizationId }, 'qbo conflict recorded');
}

/**
 * Stamp the map row with a successful inbound sync. Used after the
 * upserter has written the local change.
 */
export async function recordInboundSync(args: {
  entityMapId: string;
  lastQboUpdatedAt: string;
  qboSyncToken: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(qboEntityMap)
    .set({
      lastQboUpdatedAt: args.lastQboUpdatedAt,
      lastSyncAt: now,
      qboSyncToken: args.qboSyncToken,
      syncStatus: 'synced',
      lastError: null,
      updatedAt: now,
    })
    .where(eq(qboEntityMap.id, args.entityMapId));
}

/**
 * Create a fresh map row when the webhook references a QBO record we've
 * never seen (typical for "Create" events on records added post-migration).
 * Caller has already inserted the local record and resolved its id.
 */
export async function createEntityMap(args: {
  organizationId: string;
  realmId: string;
  entityType: string;
  qboId: string;
  localId: string;
  lastQboUpdatedAt: string;
  qboSyncToken: string | null;
}): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(qboEntityMap).values({
    id,
    organizationId: args.organizationId,
    realmId: args.realmId,
    entityType: args.entityType,
    qboId: args.qboId,
    localId: args.localId,
    qboSyncToken: args.qboSyncToken,
    lastQboUpdatedAt: args.lastQboUpdatedAt,
    lastSyncAt: now,
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
