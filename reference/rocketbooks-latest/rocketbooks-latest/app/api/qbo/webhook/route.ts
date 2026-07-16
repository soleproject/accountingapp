import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { qboWebhookEvents } from '@/db/schema/schema';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';
import { verifyIntuitSignature, type IntuitWebhookPayload } from '@/lib/qbo/webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Intuit POSTs change notifications here. The contract is unforgiving:
 *
 *   - Must reply 200 within ~3 seconds or Intuit considers the delivery
 *     failed and queues a retry. So we verify, persist, fire an Inngest
 *     event, and return — no synchronous QBO calls in the request path.
 *   - Must verify `intuit-signature` against the RAW body bytes. Re-
 *     serializing JSON would not match.
 *   - Must return 200 even when we can't process the payload, otherwise
 *     Intuit retries indefinitely. Bad signatures get 401 (Intuit treats
 *     that as a config error and pauses retries on its side).
 *
 * One row per (realm, entity) so the processor can claim and retry each
 * change independently. The realm is enough to resolve the org later —
 * we don't need organization_id on the event row.
 */
export async function POST(req: NextRequest) {
  const verifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN;
  if (!verifierToken) {
    logger.error('QBO_WEBHOOK_VERIFIER_TOKEN missing — refusing all webhooks');
    return new Response('webhook verifier not configured', { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('intuit-signature');
  if (!verifyIntuitSignature(rawBody, signature, verifierToken)) {
    logger.warn({ hasSig: Boolean(signature) }, 'qbo webhook signature invalid');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: IntuitWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as IntuitWebhookPayload;
  } catch (err) {
    // Body verified by Intuit but unparseable — log and ack so we don't
    // get retried into a loop. This should never happen with a real Intuit
    // delivery.
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'qbo webhook body unparseable');
    return new Response('ok', { status: 200 });
  }

  const now = new Date().toISOString();
  const rows = payload.eventNotifications?.flatMap((notif) =>
    (notif.dataChangeEvent?.entities ?? []).map((entity) => ({
      id: randomUUID(),
      realmId: notif.realmId,
      eventType: entity.name,
      rawPayload: { realmId: notif.realmId, entity } as unknown as Record<string, unknown>,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })),
  ) ?? [];

  if (rows.length === 0) {
    // Intuit occasionally pings with empty notifications (e.g. for
    // subscription health). Ack and move on.
    return new Response('ok', { status: 200 });
  }

  await db.insert(qboWebhookEvents).values(rows);

  // Fire-and-forget — safeSend swallows transport errors so a queue
  // outage doesn't NACK Intuit. The processor reads from
  // qbo_webhook_events directly, so even if this send fails the row is
  // still pickup-able by a periodic sweep.
  await safeSend({
    name: 'qbo/webhook.received',
    data: { eventIds: rows.map((r) => r.id) },
  });

  logger.info({ count: rows.length, realms: [...new Set(rows.map((r) => r.realmId))] }, 'qbo webhook received');
  return new Response('ok', { status: 200 });
}
