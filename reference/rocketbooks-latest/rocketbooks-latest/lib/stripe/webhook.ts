import type Stripe from 'stripe';
import { stripe } from './client';

/**
 * Verify the Stripe webhook signature and return the parsed event.
 * Throws if STRIPE_WEBHOOK_SECRET is unset or the signature is invalid —
 * callers should map either to a 401/400 response.
 *
 * `rawBody` MUST be the exact bytes from the request — do NOT pre-parse
 * as JSON. Use `await req.text()` in the route handler.
 */
export function verifyStripeWebhook(rawBody: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}
