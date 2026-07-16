import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import { qboConnections, qboWebhookEvents } from '@/db/schema/schema';
import { qboFetch, QboApiError, QboNotConnectedError } from '@/lib/qbo/client';
import { canMirrorQbo } from '@/lib/billing/entitlements';
import { isEntityEnabled, loadMirrorSettings, normalizeEntityName, type EntityKind } from '@/lib/qbo/mirror/settings';
import {
  upsertAccount,
  upsertBill,
  upsertBillPayment,
  upsertCustomer,
  upsertInvoice,
  upsertItem,
  upsertPayment,
  upsertVendor,
  type UpsertResult,
  type WebhookOperation,
} from '@/lib/qbo/mirror/upserters';
import { logger } from '@/lib/logger';

interface PersistedEntity {
  realmId: string;
  entity: {
    name: string;
    id: string;
    operation: WebhookOperation;
    lastUpdated: string;
    deletedId?: string;
  };
}

// QBO returns single-entity GETs wrapped in a key matching the PascalCase
// entity name, e.g. { Account: {...}, time: '...' }. Index by the name we
// sent in the URL path (Intuit normalizes the wrapper to PascalCase).
type QboGetEnvelope = Record<string, unknown> & { time?: string };

function entityPathSegment(kind: EntityKind): { path: string; wrapperKey: string } {
  switch (kind) {
    case 'account':     return { path: 'account',     wrapperKey: 'Account' };
    case 'customer':    return { path: 'customer',    wrapperKey: 'Customer' };
    case 'vendor':      return { path: 'vendor',      wrapperKey: 'Vendor' };
    case 'invoice':     return { path: 'invoice',     wrapperKey: 'Invoice' };
    case 'bill':        return { path: 'bill',        wrapperKey: 'Bill' };
    case 'payment':     return { path: 'payment',     wrapperKey: 'Payment' };
    case 'billPayment': return { path: 'billpayment', wrapperKey: 'BillPayment' };
    case 'item':        return { path: 'item',        wrapperKey: 'Item' };
  }
}

/**
 * Process one persisted webhook event row end-to-end. Returns a short
 * status string for logging; caller stamps it onto the row.
 */
async function processOneEvent(eventId: string): Promise<string> {
  const [event] = await db
    .select()
    .from(qboWebhookEvents)
    .where(eq(qboWebhookEvents.id, eventId))
    .limit(1);
  if (!event) return 'event_missing';

  // Idempotency: if the row is already completed, skipped, or running by
  // another worker, leave it alone. Inngest can replay deliveries on
  // retry; without this gate we'd double-process.
  if (event.status !== 'pending' && event.status !== 'failed') {
    return `already_${event.status}`;
  }

  await db
    .update(qboWebhookEvents)
    .set({
      status: 'running',
      attempts: sql`${qboWebhookEvents.attempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(qboWebhookEvents.id, eventId));

  const persisted = event.rawPayload as unknown as PersistedEntity;
  const entityName = persisted.entity.name;
  const qboId = persisted.entity.id;
  const operation = persisted.entity.operation;

  // Resolve the org from the realm. A workspace may disconnect QBO
  // between webhook send and our receive — when that happens, mark the
  // row 'skipped_no_connection' and move on. (Don't error: Intuit
  // doesn't know we've disconnected.)
  const [connection] = await db
    .select({ orgId: qboConnections.orgId })
    .from(qboConnections)
    .where(eq(qboConnections.realmId, event.realmId))
    .limit(1);
  if (!connection || !connection.orgId) {
    // No connection row, or the legacy nullable orgId column is empty
    // (shouldn't happen on connections made by the current OAuth flow,
    // but the column is nullable so we have to defend).
    await markStatus(eventId, 'skipped_no_connection', null);
    return 'skipped_no_connection';
  }
  const orgId: string = connection.orgId;

  // Entitlement gate. Webhook deliveries continue even after the user
  // cancels their mirroring subscription — we ack them but don't apply.
  // The historical migration mapping stays intact so they can re-up
  // later and not lose the (org, realm, qboId) mappings.
  if (!(await canMirrorQbo(orgId))) {
    await markStatus(eventId, 'skipped_unentitled', null);
    return 'skipped_unentitled';
  }

  const entityKind = normalizeEntityName(entityName);
  if (!entityKind) {
    await markStatus(eventId, 'skipped_unsupported_entity', `entity ${entityName} not handled`);
    return 'skipped_unsupported_entity';
  }

  const settings = await loadMirrorSettings(orgId, event.realmId);
  if (!isEntityEnabled(settings, entityKind)) {
    await markStatus(eventId, 'skipped_disabled', null);
    return 'skipped_disabled';
  }

  try {
    let raw: unknown;
    if (operation === 'Delete' || operation === 'Void') {
      // QBO can't GET a deleted record (404). The webhook envelope is
      // the only signal we'll get; synthesize a minimal stub for the
      // upserter so it can mark the local row inactive.
      raw = { Id: qboId, MetaData: { LastUpdatedTime: persisted.entity.lastUpdated } };
    } else {
      const { path, wrapperKey } = entityPathSegment(entityKind);
      const envelope = await qboFetch<QboGetEnvelope>(orgId, `/${path}/${qboId}`);
      raw = envelope[wrapperKey];
      if (!raw) {
        await markStatus(eventId, 'failed', `QBO GET returned no ${wrapperKey} envelope`);
        return 'failed_empty_envelope';
      }
    }

    const ctx = { organizationId: orgId, realmId: event.realmId };
    let result: UpsertResult;
    switch (entityKind) {
      case 'account':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertAccount({ ctx, operation, raw: raw as any });
        break;
      case 'customer':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertCustomer({ ctx, operation, raw: raw as any });
        break;
      case 'vendor':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertVendor({ ctx, operation, raw: raw as any });
        break;
      case 'invoice':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertInvoice({ ctx, operation, raw: raw as any });
        break;
      case 'bill':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertBill({ ctx, operation, raw: raw as any });
        break;
      case 'payment':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertPayment({ ctx, operation, raw: raw as any });
        break;
      case 'billPayment':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertBillPayment({ ctx, operation, raw: raw as any });
        break;
      case 'item':
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await upsertItem({ ctx, operation, raw: raw as any });
        break;
    }

    await markStatus(eventId, `completed_${result.kind}`, null);
    return `completed_${result.kind}`;
  } catch (err) {
    if (err instanceof QboNotConnectedError) {
      await markStatus(eventId, 'skipped_no_connection', err.message);
      return 'skipped_no_connection';
    }
    if (err instanceof QboApiError && err.status === 404) {
      // The entity may have been hard-deleted (rare) or the webhook
      // raced ahead of QBO's index. Mark and move on — retrying won't
      // resurrect it.
      await markStatus(eventId, 'skipped_qbo_404', err.message.slice(0, 500));
      return 'skipped_qbo_404';
    }
    const msg = err instanceof Error ? err.message : String(err);
    await markStatus(eventId, 'failed', msg.slice(0, 500));
    logger.warn({ eventId, entityName, qboId, err: msg }, 'qbo inbound event failed');
    return 'failed';
  }
}

async function markStatus(eventId: string, status: string, lastError: string | null): Promise<void> {
  await db
    .update(qboWebhookEvents)
    .set({ status, lastError, updatedAt: new Date().toISOString() })
    .where(eq(qboWebhookEvents.id, eventId));
}

export const qboInboundProcess = inngest.createFunction(
  {
    id: 'qbo-inbound-process',
    // Throttle per-installation to keep us well under QBO's rate
    // limit (500 req/min/realm). A batch typically has 1-10 events,
    // and most events fire one QBO GET, so 10 concurrent batches per
    // realm is comfortable.
    concurrency: { limit: 10 },
    retries: 2,
    triggers: [{ event: 'qbo/webhook.received' }],
  },
  async ({ event, step }) => {
    const { eventIds } = event.data;

    const results: Record<string, string> = {};
    for (const eventId of eventIds) {
      // Each event is its own step so Inngest checkpoints between them
      // and a retry resumes mid-batch instead of redoing finished work.
      results[eventId] = await step.run(`process-${eventId}`, () => processOneEvent(eventId));
    }
    return { processed: eventIds.length, results };
  },
);
