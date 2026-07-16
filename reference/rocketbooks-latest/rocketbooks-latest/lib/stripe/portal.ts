import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling } from '@/db/schema/schema';
import { stripe } from './client';

function appUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}

/**
 * Open a Stripe Customer Portal session for the org's payer. The portal is
 * Stripe-hosted and lets the customer update their card, view invoices,
 * download receipts, and cancel — saving us from building all that UI.
 *
 * Throws if no Stripe Customer exists yet for the org (i.e. they've never
 * subscribed) — callers should hide the button in that case.
 */
export async function createCustomerPortalSession(orgId: string): Promise<string> {
  const [billing] = await db
    .select({ stripeCustomerId: organizationBilling.stripeCustomerId })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, orgId))
    .limit(1);
  if (!billing?.stripeCustomerId) throw new Error('No Stripe customer exists for this organization yet');

  const session = await stripe().billingPortal.sessions.create({
    customer: billing.stripeCustomerId,
    return_url: `${appUrl()}/billing`,
  });
  return session.url;
}
