import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { billingEvents } from '@/db/schema/schema';
import { verifyStripeWebhook } from '@/lib/stripe/webhook';
import {
  handleSubscriptionUpsert,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleCheckoutSessionCompleted,
} from '@/lib/stripe/handlers';
import { logger } from '@/lib/logger';

// Stripe is webhook-driven and the body must be read raw before any parsing
// to verify the signature, so route caching must be off.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  if (!sig) return new NextResponse('missing signature', { status: 401 });

  let event;
  try {
    event = verifyStripeWebhook(raw, sig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'stripe webhook signature rejected');
    return new NextResponse(`bad signature: ${msg}`, { status: 401 });
  }

  // Dedupe via stripe_event_id unique index. Stripe retries the same event
  // when our response is slow or 5xx; that must be a no-op.
  const inserted = await db
    .insert(billingEvents)
    .values({
      id: randomUUID(),
      stripeEventId: event.id,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: billingEvents.stripeEventId })
    .returning({ id: billingEvents.id });

  if (inserted.length === 0) {
    logger.info({ stripeEventId: event.id, type: event.type }, 'stripe webhook duplicate, acking');
    return NextResponse.json({ ok: true, duplicate: true });
  }

  logger.info({ stripeEventId: event.id, type: event.type }, 'stripe webhook received');

  // Dispatch to business-logic handlers. We catch + log per-event so a
  // handler crash still records the event in billing_events (already
  // inserted above) and acks the webhook — Stripe won't retry on our
  // 200, but the event is on disk for manual replay if needed.
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      default:
        // Untracked event types still recorded in billing_events but no
        // business logic — fine for now.
        break;
    }

    await db
      .update(billingEvents)
      .set({ processedAt: new Date().toISOString() })
      .where(eq(billingEvents.id, inserted[0].id));
  } catch (err) {
    // Drizzle wraps Postgres errors in a "Failed query: ..." message and
    // hangs the real cause off .cause. Capture both so we can debug from
    // billing_events.error without a separate scripted reproduction.
    const top = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    const msg = cause ? `${top}\nCAUSE: ${cause}` : top;
    logger.error({ stripeEventId: event.id, type: event.type, err: top, cause }, 'stripe webhook handler failed');
    await db
      .update(billingEvents)
      .set({ error: msg })
      .where(eq(billingEvents.id, inserted[0].id));
    // Still return 200 — the event is recorded and can be replayed.
  }

  return NextResponse.json({ ok: true });
}
