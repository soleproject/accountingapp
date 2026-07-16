import type Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling, organizationSubscriptions, organizationEntitlements, billingProducts, plaidAccounts, imports } from '@/db/schema/schema';
import { logger } from '@/lib/logger';
import { promotePlaidAccount } from '@/lib/accounting/plaid-promote';
import { promoteImport } from '@/lib/accounting/imported-promote';
import { safeSend } from '@/lib/inngest';
import { recordPaidBillingPeriodForClient } from '@/lib/enterprise/revenue-share';
import { recordPaidBillingPeriodForUserReferral } from '@/lib/referral/user-revenue-share';
import { PRIVATE_LABEL_FEATURE_KEY } from './checkout';
import { stripe } from './client';

/**
 * Map Stripe subscription status → our organization_billing.status.
 *
 *  active / trialing → 'active'   — green-light, no enforcement
 *  past_due          → 'past_due' — grace state, Stripe is retrying
 *  unpaid            → 'locked'   — Smart Retries exhausted, write-block
 *  canceled          → 'canceled' — no enforcement (no longer a customer)
 *  incomplete*       → 'inactive' — checkout abandoned mid-flow
 *
 * 'locked' is the only state Phase B's write-gate will treat as hard
 * blocking. 'past_due' shows a banner but still allows writes — we want
 * customers to fix payment, not lose access immediately.
 */
function aggregateStatus(stripeStatus: Stripe.Subscription.Status): string {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'locked';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:
      return 'inactive';
  }
}

/**
 * Lookup our billing_product row for a Stripe Price. Used to attribute a
 * new subscription to the right local product (so we know it's the base
 * seat vs. a future add-on). Returns null if the price isn't catalogued —
 * we still record the subscription, just without a product link.
 */
async function findProductByStripePrice(stripePriceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: billingProducts.id })
    .from(billingProducts)
    .where(eq(billingProducts.stripePriceId, stripePriceId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Resolve organization_id from a Stripe subscription. We set
 * subscription_data.metadata.organization_id at checkout-session time, so
 * it should always be present for subs we created. Falls back to looking
 * up the customer if metadata is missing (covers manual subs created from
 * the Stripe dashboard).
 */
async function resolveOrgIdFromSubscription(sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.organization_id;
  if (fromMeta) return fromMeta;

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const [billing] = await db
    .select({ organizationId: organizationBilling.organizationId })
    .from(organizationBilling)
    .where(eq(organizationBilling.stripeCustomerId, customerId))
    .limit(1);
  return billing?.organizationId ?? null;
}

function toIsoOrNull(stripeTimestamp: number | null | undefined): string | null {
  if (!stripeTimestamp) return null;
  return new Date(stripeTimestamp * 1000).toISOString();
}

/**
 * Read the period dates off a subscription. Stripe sometimes nests these
 * on the first item rather than the top-level subscription depending on
 * how the sub was created.
 */
function periodDates(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = sub.items?.data?.[0];
  const startTs =
    (sub as unknown as { current_period_start?: number }).current_period_start ??
    (item as unknown as { current_period_start?: number } | undefined)?.current_period_start ??
    null;
  const endTs =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ??
    null;
  return { start: toIsoOrNull(startTs), end: toIsoOrNull(endTs) };
}

/**
 * customer.subscription.created / updated → upsert organization_subscriptions
 * and update the org's aggregate status. Idempotent via the unique index
 * on stripe_subscription_id — works as both insert and update.
 */
export async function handleSubscriptionUpsert(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgIdFromSubscription(sub);
  if (!orgId) {
    logger.warn({ subscriptionId: sub.id }, 'stripe subscription event with no resolvable org_id');
    return;
  }

  const item = sub.items.data[0];
  const priceId = typeof item.price === 'string' ? item.price : item.price.id;
  const productId = await findProductByStripePrice(priceId);
  const { start, end } = periodDates(sub);

  const values = {
    id: randomUUID(),
    organizationId: orgId,
    billingProductId: productId ?? '',
    stripeSubscriptionId: sub.id,
    status: sub.status,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  };

  if (!productId) {
    logger.warn({ subscriptionId: sub.id, priceId }, 'stripe subscription has no matching billing_product');
    return;
  }

  await db
    .insert(organizationSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: organizationSubscriptions.stripeSubscriptionId,
      set: {
        status: values.status,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAtPeriodEnd: values.cancelAtPeriodEnd,
        billingProductId: values.billingProductId,
        updatedAt: new Date().toISOString(),
      },
    });

  // organization_billing.status mirrors the most relevant active sub. For
  // PR-2 there's only one sub per org so this is a direct copy; once we
  // have add-ons we'll need an aggregate query here.
  await db
    .insert(organizationBilling)
    .values({
      organizationId: orgId,
      status: aggregateStatus(sub.status),
      currentPeriodEnd: end,
    })
    .onConflictDoUpdate({
      target: organizationBilling.organizationId,
      set: {
        status: aggregateStatus(sub.status),
        currentPeriodEnd: end,
        updatedAt: new Date().toISOString(),
      },
    });

  logger.info({ orgId, subscriptionId: sub.id, status: sub.status }, 'stripe subscription upserted');

  // Partner revenue-share ledger: when a non-demo sub is active or
  // trialing for an org whose owner is a client of a tier'd enterprise,
  // record the partner's share for this billing period. Trialing on a
  // real (non-demo) Stripe sub counts as paying — the partner is owed
  // the next paid invoice's share. The demo_full product (synthetic
  // trial signups) is excluded.
  //
  // Non-fatal: if the ledger insert fails the subscription upsert above
  // still stuck. Idempotent against retries via the unique index on
  // (client_organization_id, billing_period_start).
  const featureKeyForProduct = productId ? await featureKeyById(productId) : null;
  const isPayingProduct = featureKeyForProduct !== null && featureKeyForProduct !== 'demo_full';
  const isPayingStatus = sub.status === 'active' || sub.status === 'trialing';
  if (isPayingProduct && isPayingStatus && start && end) {
    try {
      const result = await recordPaidBillingPeriodForClient({
        clientOrganizationId: orgId,
        billingPeriodStart: new Date(start),
        billingPeriodEnd: new Date(end),
      });
      if (result.inserted) {
        logger.info({ orgId, subscriptionId: sub.id }, 'revenue-share row recorded for paid period');
      }
    } catch (rsErr) {
      logger.warn({ orgId, subscriptionId: sub.id, err: rsErr }, 'revenue-share ledger insert failed');
    }

    // Additive: if this org was referred by a regular user, accrue their flat
    // 20% referral share for this period too. No-ops when there's no user
    // referrer. Same best-effort handling.
    try {
      const refResult = await recordPaidBillingPeriodForUserReferral({
        referredOrganizationId: orgId,
        billingPeriodStart: new Date(start),
        billingPeriodEnd: new Date(end),
      });
      if (refResult.inserted) {
        logger.info({ orgId, subscriptionId: sub.id }, 'user-referral revenue-share row recorded for paid period');
      }
    } catch (rsErr) {
      logger.warn({ orgId, subscriptionId: sub.id, err: rsErr }, 'user-referral revenue-share ledger insert failed');
    }
  }
}

/** Look up the featureKey of a billing_product by id — used to gate the
 *  partner revenue-share write so demo_full trial subs don't generate
 *  a ledger row. */
async function featureKeyById(productId: string): Promise<string | null> {
  const [row] = await db
    .select({ featureKey: billingProducts.featureKey })
    .from(billingProducts)
    .where(eq(billingProducts.id, productId))
    .limit(1);
  return row?.featureKey ?? null;
}

/**
 * customer.subscription.deleted → mark canceled. Stripe sends this once a
 * subscription is fully terminated (e.g. user canceled and the period
 * ended, or admin canceled immediately).
 */
export async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const orgId = await resolveOrgIdFromSubscription(sub);
  if (!orgId) return;

  await db
    .update(organizationSubscriptions)
    .set({ status: 'canceled', updatedAt: new Date().toISOString() })
    .where(eq(organizationSubscriptions.stripeSubscriptionId, sub.id));

  await db
    .update(organizationBilling)
    .set({ status: 'canceled', updatedAt: new Date().toISOString() })
    .where(eq(organizationBilling.organizationId, orgId));

  logger.info({ orgId, subscriptionId: sub.id }, 'stripe subscription canceled');
}

/**
 * invoice.payment_failed → set past_due. Stripe will continue Smart Retries
 * on its own; the subscription will eventually transition to unpaid
 * (handled by handleSubscriptionUpsert via aggregateStatus → 'locked')
 * or recover. We just propagate the immediate past_due signal so the UI
 * can warn the customer.
 */
export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  await db
    .update(organizationBilling)
    .set({ status: 'past_due', updatedAt: new Date().toISOString() })
    .where(eq(organizationBilling.stripeCustomerId, customerId));

  logger.warn({ invoiceId: invoice.id, customerId }, 'stripe invoice payment failed');
}

/**
 * invoice.paid → if we previously marked past_due, flip back to active.
 * This is the recovery half of payment_failed. Subscription.updated will
 * usually also fire and overwrite with the canonical status — both are OK.
 */
export async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  // Only flip past_due → active. Don't touch canceled/inactive/locked
  // rows — those need a fresh subscription event to recover.
  await db
    .update(organizationBilling)
    .set({ status: 'active', updatedAt: new Date().toISOString() })
    .where(eq(organizationBilling.stripeCustomerId, customerId));

  logger.info({ invoiceId: invoice.id, customerId }, 'stripe invoice paid');
}

/**
 * checkout.session.completed → grant year-unlock entitlements.
 *
 * Two entry paths:
 *  - mode='payment':      a standalone year-unlock purchase from /billing.
 *                         Metadata on the session carries org/product/year.
 *  - mode='subscription': a base subscribe that bundled year-unlock items
 *                         via optional_items. We expand the line items and
 *                         grant one entitlement per year-unlock line.
 *                         Subscription state itself is driven by
 *                         customer.subscription.* events; this branch only
 *                         handles the one-time bundled items.
 *
 * Idempotent via grantYearUnlockEntitlement's per-row check; safe to retry.
 */
export async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.mode === 'payment') {
    await processOneTimeUnlockCheckout(session);
    return;
  }
  if (session.mode === 'subscription') {
    await processSubscriptionCheckoutExtras(session);
    return;
  }
  if (session.mode === 'setup') {
    await processSetupCheckout(session);
    return;
  }
}

/**
 * A firm finished adding a card (Stripe Checkout setup mode). Pull the saved
 * payment method off the setup intent and make it the customer's default so
 * future firm-paid client subscriptions charge it. No card data is stored
 * locally — Stripe vaults it on the customer.
 */
async function processSetupCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
  if (!customerId || !setupIntentId) {
    logger.warn({ sessionId: session.id }, 'setup checkout missing customer or setup_intent');
    return;
  }
  const si = await stripe().setupIntents.retrieve(setupIntentId);
  const pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (!pm) {
    logger.warn({ sessionId: session.id }, 'setup checkout has no payment_method');
    return;
  }
  await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
  logger.info({ customerId }, 'firm billing default payment method set');

  // Firm-pays clients are billed monthly IN ARREARS by the firm-billing cron — no
  // per-client subscriptions are created when the firm's card lands. The card is
  // simply on file now for the cron to charge on the 5th.
}

async function processOneTimeUnlockCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const meta = session.metadata ?? {};
  const orgId = meta.organization_id;
  const billingProductId = meta.billing_product_id;
  const periodYearStr = meta.period_year;
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!orgId || !billingProductId || !periodYearStr) {
    logger.warn({ sessionId: session.id, meta }, 'one-time checkout missing required metadata');
    return;
  }
  const periodYear = parseInt(periodYearStr, 10);
  if (!Number.isFinite(periodYear)) {
    logger.warn({ sessionId: session.id, periodYearStr }, 'one-time checkout has non-numeric period_year');
    return;
  }

  // Pull the unit amount off the catalog (Stripe Checkout returns
  // amount_total but that includes tax/discounts which we don't use).
  const [product] = await db
    .select({ unitAmountCents: billingProducts.unitAmountCents, currency: billingProducts.currency })
    .from(billingProducts)
    .where(eq(billingProducts.id, billingProductId))
    .limit(1);
  if (!product) {
    logger.warn({ sessionId: session.id, billingProductId }, 'one-time checkout product not in catalog');
    return;
  }

  await grantYearUnlockEntitlement({
    orgId,
    billingProductId,
    periodYear,
    unitAmountCents: product.unitAmountCents,
    currency: product.currency,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId ?? null,
  });
}

/**
 * Find year-unlock items the customer toggled on during a base Subscribe
 * checkout (via optional_items) and grant the matching entitlements. The
 * subscription itself is recorded by handleSubscriptionUpsert when the
 * customer.subscription.created event fires; this branch only handles
 * the bundled one-time year-unlock line items.
 */
async function processSubscriptionCheckoutExtras(session: Stripe.Checkout.Session): Promise<void> {
  const orgId = session.client_reference_id;
  if (!orgId) {
    logger.warn({ sessionId: session.id }, 'subscription checkout missing client_reference_id; cannot grant bundled unlocks');
    return;
  }

  // line_items aren't included on the webhook payload by default; pull them.
  const lineItems = await stripe().checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price'],
  });

  let isPrivateLabelCheckout = false;
  for (const item of lineItems.data) {
    const priceId = typeof item.price === 'string' ? item.price : item.price?.id;
    if (!priceId) continue;

    const [product] = await db
      .select({
        id: billingProducts.id,
        featureKey: billingProducts.featureKey,
        periodYear: billingProducts.periodYear,
        unitAmountCents: billingProducts.unitAmountCents,
        currency: billingProducts.currency,
      })
      .from(billingProducts)
      .where(eq(billingProducts.stripePriceId, priceId))
      .limit(1);
    if (!product) continue;

    if (product.featureKey === PRIVATE_LABEL_FEATURE_KEY) isPrivateLabelCheckout = true;

    // Recurring add-ons (qbo_mirroring etc.) are tracked as separate
    // subscription items and handled by customer.subscription.* webhooks.
    if (product.featureKey !== 'current_year_unlock' && product.featureKey !== 'prior_year') {
      continue;
    }

    const periodYear = product.featureKey === 'current_year_unlock'
      ? new Date().getUTCFullYear()
      : product.periodYear;
    if (!periodYear) {
      logger.warn({ sessionId: session.id, productId: product.id }, 'year unlock product missing period_year; skipping');
      continue;
    }

    await grantYearUnlockEntitlement({
      orgId,
      billingProductId: product.id,
      periodYear,
      unitAmountCents: product.unitAmountCents,
      currency: product.currency,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: null,
    });
  }

  // Enterprise onboarding PL checkout (orgId = the firm): make the collected
  // card the customer default so deferred firm-paid client subs can charge,
  // then create those subs. Best-effort, idempotent.
  if (isPrivateLabelCheckout) {
    try {
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (subId && customerId) {
        const sub = await stripe().subscriptions.retrieve(subId);
        const pm = typeof sub.default_payment_method === 'string' ? sub.default_payment_method : sub.default_payment_method?.id;
        if (pm) await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
      }
    } catch (e) {
      logger.warn({ sessionId: session.id, err: e }, 'setting customer default PM after PL checkout failed');
    }
    // Firm-pays clients are billed by the monthly arrears cron, not per-client subs.
  }
}

interface GrantYearUnlockArgs {
  orgId: string;
  billingProductId: string;
  periodYear: number;
  unitAmountCents: number;
  currency: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
}

async function grantYearUnlockEntitlement(args: GrantYearUnlockArgs): Promise<void> {
  const { orgId, billingProductId, periodYear, unitAmountCents, currency, stripeCheckoutSessionId, stripePaymentIntentId } = args;

  // Manual idempotency check — the partial unique index (where revoked_at
  // is null) isn't reachable from Drizzle's onConflict yet, so we look
  // up + skip when an ACTIVE row already exists. Revoked rows are ignored
  // here so re-purchasing after a refund / admin revocation grants a fresh
  // entitlement; the partial unique index allows the new insert because
  // the older row's revoked_at is set.
  const [existing] = await db
    .select({ id: organizationEntitlements.id })
    .from(organizationEntitlements)
    .where(and(
      eq(organizationEntitlements.organizationId, orgId),
      eq(organizationEntitlements.periodYear, periodYear),
      isNull(organizationEntitlements.revokedAt),
    ))
    .limit(1);

  if (existing) {
    logger.info({ orgId, periodYear, existingId: existing.id }, 'entitlement already granted, ignoring');
    return;
  }

  await db.insert(organizationEntitlements).values({
    id: randomUUID(),
    organizationId: orgId,
    periodYear,
    billingProductId,
    stripeCheckoutSessionId,
    stripePaymentIntentId,
    unitAmountCents,
    currency,
  });

  logger.info({ orgId, periodYear, billingProductId }, 'year unlock entitlement granted');

  // Re-promote any previously-quarantined imports for this org. Both
  // promote functions are idempotent (Plaid: ON CONFLICT DO NOTHING on
  // transactions.reference; Veryfi: alreadyPromoted set + promoted_transaction_id
  // check), so re-running across all rows is safe. Logged as warn-on-failure
  // so a downstream hiccup doesn't roll back the entitlement insert — the
  // customer paid; we can re-promote later via the next regular sync.
  try {
    const [plaid, importRows] = await Promise.all([
      db
        .select({ id: plaidAccounts.id })
        .from(plaidAccounts)
        .where(eq(plaidAccounts.linkedOrganizationId, orgId)),
      db
        .select({ id: imports.id })
        .from(imports)
        .where(eq(imports.organizationId, orgId)),
    ]);
    // Collect every newly-promoted transaction id across both surfaces so
    // we can fire ONE auto-categorize event at the end. The job batches
    // internally, so a single event with the union is fine — and saves
    // N Inngest publishes when an org has many sources.
    const newlyPromoted: string[] = [];
    for (const a of plaid) {
      const result = await promotePlaidAccount({ organizationId: orgId, plaidAccountId: a.id });
      newlyPromoted.push(...result.newTransactionIds);
      logger.info(
        { orgId, plaidAccountId: a.id, promoted: result.promoted, pendingUnlock: result.pendingUnlock },
        'post-unlock plaid re-promote',
      );
    }
    for (const imp of importRows) {
      const result = await promoteImport({ organizationId: orgId, importId: imp.id });
      newlyPromoted.push(...result.newTransactionIds);
      logger.info(
        { orgId, importId: imp.id, promoted: result.promoted, pendingUnlock: result.pendingUnlock },
        'post-unlock import re-promote',
      );
    }
    if (newlyPromoted.length > 0) {
      await safeSend({
        name: 'transactions/auto-categorize.requested',
        data: { organizationId: orgId, transactionIds: newlyPromoted },
      });
      logger.info({ orgId, count: newlyPromoted.length }, 'post-unlock auto-categorize requested');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId, periodYear, err: msg }, 'post-unlock re-promote failed (entitlement was granted)');
  }
}
