import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationSubscriptions, billingProducts } from '@/db/schema/schema';
import { stripe } from './client';
import { priceIdForFeatureKey } from './checkout';
import { getClientBillingPlan } from '@/lib/enterprise/client-billing';

export type TierSyncReason =
  | 'changed'
  | 'firm_paid'
  | 'no_subscription'
  | 'demo'
  | 'product_missing'
  | 'tier_not_linked_to_stripe'
  | 'already_on_plan'
  | 'no_subscription_item'
  | 'error';

export interface TierSyncResult {
  changed: boolean;
  reason: TierSyncReason;
  error?: string;
}

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Align a client org's LIVE Stripe subscription with its current accounting
 * tier price (their accounting_tier → billing product). Called after a tier
 * change so an already-subscribed client's bill follows their new plan.
 *
 * Deliberately best-effort and self-contained — it NEVER throws, so tier
 * assignment (the caller) always succeeds even when billing can't be synced:
 *  - No active subscription yet → no-op. The client gets the right price at
 *    checkout, since getClientBillingPlan already returns the tier product.
 *  - firm_pays client → skipped for now. The covering subscription lives on the
 *    FIRM's customer; swapping that is a separate (pending) decision.
 *  - Tier product not linked to Stripe yet (DB-only seed) → no-op with a clear
 *    reason. Run scripts/seed-accounting-tier-products.ts WITH a Stripe key
 *    (or set STRIPE_TEST_PRICE_OVERRIDES) to enable live swaps.
 */
export async function syncClientSubscriptionToTier(orgId: string): Promise<TierSyncResult> {
  try {
    const plan = await getClientBillingPlan(orgId);
    // Firm covers this client — the charge is on the firm's customer, not a
    // client subscription. Out of scope until the firm-pays-under-tiers model
    // is decided.
    if (plan.firmPaid) return { changed: false, reason: 'firm_paid' };

    const subs = await db
      .select({
        id: organizationSubscriptions.id,
        stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
        billingProductId: organizationSubscriptions.billingProductId,
        status: organizationSubscriptions.status,
      })
      .from(organizationSubscriptions)
      .where(eq(organizationSubscriptions.organizationId, orgId));
    const active = subs.find((s) => ACTIVE_STATUSES.has(s.status));
    if (!active) return { changed: false, reason: 'no_subscription' };
    // Synthetic demo trial subs never touch Stripe.
    if (active.stripeSubscriptionId.startsWith('demo_')) return { changed: false, reason: 'demo' };

    const [target] = await db
      .select({ id: billingProducts.id })
      .from(billingProducts)
      .where(and(eq(billingProducts.featureKey, plan.clientPriceFeatureKey), eq(billingProducts.active, true)))
      .limit(1);
    if (!target) return { changed: false, reason: 'product_missing' };
    if (target.id === active.billingProductId) return { changed: false, reason: 'already_on_plan' };

    // Resolve the target Stripe price (override-aware). Missing link → no-op.
    let priceId: string;
    try {
      priceId = await priceIdForFeatureKey(plan.clientPriceFeatureKey);
    } catch {
      return { changed: false, reason: 'tier_not_linked_to_stripe' };
    }

    const sub = await stripe().subscriptions.retrieve(active.stripeSubscriptionId);
    const itemId = sub.items.data[0]?.id;
    if (!itemId) return { changed: false, reason: 'no_subscription_item' };

    await stripe().subscriptions.update(active.stripeSubscriptionId, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: 'create_prorations',
    });
    await db
      .update(organizationSubscriptions)
      .set({ billingProductId: target.id })
      .where(eq(organizationSubscriptions.id, active.id));

    return { changed: true, reason: 'changed' };
  } catch (e) {
    return { changed: false, reason: 'error', error: e instanceof Error ? e.message : 'sync failed' };
  }
}
