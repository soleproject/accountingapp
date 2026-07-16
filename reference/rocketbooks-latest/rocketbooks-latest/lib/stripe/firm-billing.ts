import 'server-only';
import type Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling, organizationSubscriptions, billingProducts, organizations } from '@/db/schema/schema';
import { stripe } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { priceIdForFeatureKey, PRIVATE_LABEL_FEATURE_KEY } from './checkout';
import { firmPaidClientOrgIds } from '@/lib/enterprise/client-billing';
import { maybeGetAccountingTier, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';

/** Does the firm have an active $95/mo private-label subscription? */
export async function firmPrivateLabelActive(enterpriseId: string): Promise<boolean> {
  const rows = await db
    .select({ status: organizationSubscriptions.status })
    .from(organizationSubscriptions)
    .innerJoin(billingProducts, eq(billingProducts.id, organizationSubscriptions.billingProductId))
    .where(
      and(
        eq(organizationSubscriptions.organizationId, enterpriseId),
        eq(billingProducts.featureKey, PRIVATE_LABEL_FEATURE_KEY),
      ),
    );
  return rows.some((r) => r.status === 'active' || r.status === 'trialing' || r.status === 'past_due');
}

/**
 * Does the firm have a card on file at Stripe? Reads the stored customer id
 * (never creates one) and checks for a default / any payment method. We store
 * no card data — only the Stripe customer id.
 */
export async function firmHasPaymentMethod(enterpriseId: string): Promise<boolean> {
  const [row] = await db
    .select({ customerId: organizationBilling.stripeCustomerId })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, enterpriseId))
    .limit(1);
  if (!row?.customerId) return false;
  try {
    const customer = await stripe().customers.retrieve(row.customerId);
    if ((customer as Stripe.DeletedCustomer).deleted) return false;
    const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    if (def) return true;
    const pms = await stripe().paymentMethods.list({ customer: row.customerId, limit: 1 });
    return pms.data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Bill the FIRM (enterprise) $69/mo for a client it covers. Creates a
 * private_label_69_monthly subscription on the firm's own Stripe customer,
 * tagged with the client org in metadata. The existing subscription webhook
 * (resolveOrgIdFromSubscription → metadata.organization_id) then grants the
 * CLIENT org its entitlement + records the revenue-share row, while the charge
 * lands on the firm's card.
 *
 * Requires the firm to have a Stripe customer with a payment method (they get
 * one from their private-label seat checkout). Best-effort: returns an error
 * string instead of throwing so client creation/import never breaks.
 */
export async function createFirmPaidClientSubscription(args: {
  enterpriseId: string;
  clientOrgId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const firmCustomerId = await getOrCreateStripeCustomer(args.enterpriseId);
    // Firm pays the client's tier REDUCED price ($29/$65/$119) — the selected
    // tier is what's applied, with NO flat-$69 fallback. Untiered clients (an
    // edge; imports/add-company always set a tier first) default to Starter reduced.
    const [clientOrg] = await db
      .select({ accountingTier: organizations.accountingTier })
      .from(organizations)
      .where(eq(organizations.id, args.clientOrgId))
      .limit(1);
    const tier = maybeGetAccountingTier(clientOrg?.accountingTier) ?? ACCOUNTING_TIERS.starter;
    const priceId = await priceIdForFeatureKey(tier.reducedBillingFeatureKey);
    await stripe().subscriptions.create({
      customer: firmCustomerId,
      items: [{ price: priceId, quantity: 1 }],
      metadata: {
        organization_id: args.clientOrgId, // webhook attributes entitlement to the client
        enterprise_id: args.enterpriseId,
        firm_paid: 'true',
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Firm billing failed' };
  }
}

/**
 * Create firm-paid $69/mo subscriptions for any client the firm covers that
 * doesn't already have one. Idempotent — skips clients already in the firm's
 * existing (non-canceled) firm_paid subscription set, so re-fires (duplicate
 * webhooks, page revisits) don't double-charge. Best-effort: logs failures,
 * never throws. Call once the firm's card is on file (post-checkout webhook).
 */
export async function ensureFirmPaidSubscriptions(enterpriseId: string): Promise<{ created: number }> {
  const orgIds = await firmPaidClientOrgIds(enterpriseId);
  if (orgIds.length === 0) return { created: 0 };

  // Which client orgs already have a firm-paid sub on the firm's customer?
  const already = new Set<string>();
  const [billing] = await db
    .select({ customerId: organizationBilling.stripeCustomerId })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, enterpriseId))
    .limit(1);
  if (billing?.customerId) {
    try {
      const subs = await stripe().subscriptions.list({ customer: billing.customerId, status: 'all', limit: 100 });
      for (const s of subs.data) {
        const orgId = s.metadata?.organization_id;
        if (s.metadata?.firm_paid === 'true' && orgId && s.status !== 'canceled' && s.status !== 'incomplete_expired') {
          already.add(orgId);
        }
      }
    } catch (e) {
      console.error('ensureFirmPaidSubscriptions: listing firm subscriptions failed', enterpriseId, e);
    }
  }

  let created = 0;
  for (const orgId of orgIds) {
    if (already.has(orgId)) continue;
    const res = await createFirmPaidClientSubscription({ enterpriseId, clientOrgId: orgId });
    if (res.ok) created += 1;
    else console.error('ensureFirmPaidSubscriptions: create failed', enterpriseId, orgId, res.error);
  }
  return { created };
}
