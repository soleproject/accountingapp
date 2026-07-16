import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { qboConnections, qboEntityMap, qboOutboundQueue } from '@/db/schema/schema';
import { qboFetch, QboApiError } from '@/lib/qbo/client';
import { canMirrorQbo } from '@/lib/billing/entitlements';
import {
  claimNextOutboundRow,
  markOutboundCompleted,
  markOutboundFailed,
} from '@/lib/qbo/mirror/outbound';
import { logger } from '@/lib/logger';

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000; // 30s, doubles per attempt

/**
 * Resolve the realm + org for a queue row. The row carries both columns
 * already but we re-read the connection to make sure it still exists
 * (someone disconnected QBO while a row was pending).
 */
async function ensureConnectionActive(orgId: string, realmId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: qboConnections.id })
    .from(qboConnections)
    .where(and(eq(qboConnections.orgId, orgId), eq(qboConnections.realmId, realmId)))
    .limit(1);
  return Boolean(row);
}

interface EntityMapState {
  qboId: string | null;
  syncToken: string | null;
}

async function loadMapState(orgId: string, realmId: string, entityType: string, localId: string): Promise<EntityMapState> {
  const [row] = await db
    .select({ qboId: qboEntityMap.qboId, qboSyncToken: qboEntityMap.qboSyncToken })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, orgId),
      eq(qboEntityMap.realmId, realmId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.localId, localId),
    ))
    .limit(1);
  if (!row) return { qboId: null, syncToken: null };
  return { qboId: row.qboId, syncToken: row.qboSyncToken };
}

function entityPathSegment(entityType: string): { create: string; wrapperKey: string } {
  switch (entityType) {
    case 'account':     return { create: 'account',     wrapperKey: 'Account' };
    case 'customer':    return { create: 'customer',    wrapperKey: 'Customer' };
    case 'vendor':      return { create: 'vendor',      wrapperKey: 'Vendor' };
    case 'invoice':     return { create: 'invoice',     wrapperKey: 'Invoice' };
    case 'bill':        return { create: 'bill',        wrapperKey: 'Bill' };
    case 'payment':     return { create: 'payment',     wrapperKey: 'Payment' };
    case 'billPayment': return { create: 'billpayment', wrapperKey: 'BillPayment' };
    default: throw new Error(`Unknown entityType ${entityType}`);
  }
}

/**
 * Write the qboId + SyncToken to qbo_entity_map after a successful push.
 * For a create-op response we INSERT a new map row; for an update we
 * UPDATE the existing one. Local id was the linking key on the way out;
 * the QBO id is what we just learned.
 */
async function recordOutboundResult(
  orgId: string,
  realmId: string,
  entityType: string,
  localId: string,
  qboId: string,
  syncToken: string,
): Promise<void> {
  const now = new Date().toISOString();
  const [existing] = await db
    .select({ id: qboEntityMap.id })
    .from(qboEntityMap)
    .where(and(
      eq(qboEntityMap.organizationId, orgId),
      eq(qboEntityMap.realmId, realmId),
      eq(qboEntityMap.entityType, entityType),
      eq(qboEntityMap.localId, localId),
    ))
    .limit(1);

  if (existing) {
    await db
      .update(qboEntityMap)
      .set({
        qboId,
        qboSyncToken: syncToken,
        lastLocalUpdatedAt: now,
        lastSyncAt: now,
        syncStatus: 'synced',
        lastError: null,
        updatedAt: now,
      })
      .where(eq(qboEntityMap.id, existing.id));
  } else {
    await db.insert(qboEntityMap).values({
      id: randomUUID(),
      organizationId: orgId,
      realmId,
      entityType,
      qboId,
      localId,
      qboSyncToken: syncToken,
      lastLocalUpdatedAt: now,
      lastSyncAt: now,
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
    });
  }
}

interface QboMutationEnvelope {
  Id: string;
  SyncToken: string;
}

/**
 * Drain pending outbound rows for the realms referenced by this event.
 * Inngest concurrency keyed on realm so two simultaneous batches for the
 * same realm queue up instead of stomping on shared SyncTokens.
 */
export const qboOutboundDrain = inngest.createFunction(
  {
    id: 'qbo-outbound-drain',
    // Per-realm serialization. QBO's SyncToken model is optimistic-lock
    // and a parallel push from us against the same entity would just 5010
    // the loser. Run one at a time per realm.
    concurrency: { limit: 1, key: 'event.data.realmId' },
    retries: 0, // we manage retries via the queue row's status + scheduledAt
    triggers: [{ event: 'qbo/outbound.enqueued' }],
  },
  async ({ event, step }) => {
    // Callers can pass either realmId directly OR queueIds; resolve to a
    // realmId so the per-realm concurrency lock holds.
    const resolvedRealmId = await step.run('resolve-realm', async (): Promise<string | null> => {
      if (event.data.realmId) return event.data.realmId;
      const queueIds = (event.data.queueIds ?? []) as string[];
      if (queueIds.length === 0) return null;
      const rows = await db
        .select({ realmId: qboOutboundQueue.realmId })
        .from(qboOutboundQueue)
        .where(eq(qboOutboundQueue.id, queueIds[0]))
        .limit(1);
      return rows[0]?.realmId ?? null;
    });
    if (!resolvedRealmId) return { drained: 0 };
    const realmId: string = resolvedRealmId;

    let drained = 0;

    // Loop until the queue is empty for this realm. One step per row so
    // Inngest checkpoints and a single failure doesn't lose progress.
    while (true) {
      const row = await step.run(`claim-${drained}`, async () => claimNextOutboundRow(realmId));
      if (!row) break;
      drained++;

      await step.run(`process-${row.id}`, async () => {
        try {
          if (!(await ensureConnectionActive(row.organizationId, row.realmId))) {
            await markOutboundFailed(row.id, 'QBO connection no longer active', null);
            return;
          }
          if (!(await canMirrorQbo(row.organizationId))) {
            await markOutboundFailed(row.id, 'Org not entitled to mirror', null);
            return;
          }

          const { create: path, wrapperKey } = entityPathSegment(row.entityType);
          const payload = { ...(row.payload as Record<string, unknown>) };

          if (row.operation === 'create') {
            // Plain POST /v3/company/{realm}/{entity} with the body.
            const res = await qboFetch<{ [key: string]: QboMutationEnvelope }>(row.organizationId, `/${path}`, {
              method: 'POST',
              body: payload,
            });
            const entity = res[wrapperKey];
            if (!entity?.Id) {
              await markOutboundFailed(row.id, `QBO returned no ${wrapperKey} envelope`, null);
              return;
            }
            await recordOutboundResult(row.organizationId, row.realmId, row.entityType, row.localId, entity.Id, entity.SyncToken ?? '0');
            await markOutboundCompleted(row.id, entity.Id);
            return;
          }

          if (row.operation === 'update') {
            // Updates require fresh Id + SyncToken from the map row. We do
            // NOT trust queue payload to carry SyncToken — between enqueue
            // and now an inbound webhook may have advanced it.
            const map = await loadMapState(row.organizationId, row.realmId, row.entityType, row.localId);
            if (!map.qboId) {
              await markOutboundFailed(row.id, 'No qbo_entity_map row for local id; cannot update', null);
              return;
            }
            payload.Id = map.qboId;
            payload.SyncToken = map.syncToken ?? '0';
            payload.sparse = true; // partial update, QBO leaves untouched fields alone
            const res = await qboFetch<{ [key: string]: QboMutationEnvelope }>(row.organizationId, `/${path}`, {
              method: 'POST',
              body: payload,
            });
            const entity = res[wrapperKey];
            if (!entity?.Id) {
              await markOutboundFailed(row.id, `QBO returned no ${wrapperKey} envelope on update`, null);
              return;
            }
            await recordOutboundResult(row.organizationId, row.realmId, row.entityType, row.localId, entity.Id, entity.SyncToken ?? '0');
            await markOutboundCompleted(row.id, entity.Id);
            return;
          }

          if (row.operation === 'delete') {
            // QBO doesn't truly delete most entities — it's a soft-delete
            // via the `?operation=delete` query flag with an Id+SyncToken
            // body. For Account/Customer/Vendor, set Active=false via the
            // update path instead. For Invoice/Bill/Payment etc., this is
            // the canonical delete.
            const map = await loadMapState(row.organizationId, row.realmId, row.entityType, row.localId);
            if (!map.qboId) {
              await markOutboundFailed(row.id, 'No qbo_entity_map row for local id; cannot delete', null);
              return;
            }
            const res = await qboFetch<{ [key: string]: QboMutationEnvelope }>(row.organizationId, `/${path}`, {
              method: 'POST',
              query: { operation: 'delete' },
              body: { Id: map.qboId, SyncToken: map.syncToken ?? '0' },
            });
            const entity = res[wrapperKey];
            if (entity?.SyncToken) {
              await recordOutboundResult(row.organizationId, row.realmId, row.entityType, row.localId, map.qboId, entity.SyncToken);
            }
            await markOutboundCompleted(row.id, map.qboId);
            return;
          }

          await markOutboundFailed(row.id, `Unknown operation: ${row.operation}`, null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isApiErr = err instanceof QboApiError;
          // 5010 Stale Object — someone else changed the same entity in
          // QBO between our SyncToken read and our push. Inbound webhook
          // for that change is in flight (or already landed). Stamp a
          // structured error and stop retrying; conflict-log UI (future)
          // will surface it.
          if (isApiErr && err.body.includes('5010')) {
            await markOutboundFailed(row.id, `QBO stale object (5010): ${msg.slice(0, 300)}`, null);
            logger.warn({ queueId: row.id, entityType: row.entityType, localId: row.localId }, 'qbo outbound 5010 — recorded');
            return;
          }
          // 429 rate limited: short backoff. Others: exponential up to MAX_ATTEMPTS.
          const attemptCount = row.attempts;
          if (attemptCount >= MAX_ATTEMPTS) {
            await markOutboundFailed(row.id, `Exhausted ${MAX_ATTEMPTS} attempts: ${msg.slice(0, 300)}`, null);
            return;
          }
          const isRateLimit = isApiErr && err.status === 429;
          const delay = isRateLimit ? 60_000 : BASE_BACKOFF_MS * Math.pow(2, attemptCount - 1);
          await markOutboundFailed(row.id, msg.slice(0, 500), delay);
        }
      });
    }

    return { realmId, drained };
  },
);
