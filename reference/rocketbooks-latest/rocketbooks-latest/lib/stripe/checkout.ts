import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { billingProducts, organizations } from '@/db/schema/schema';
import { stripe } from './client';
import { getOrCreateStripeCustomer } from './customers';
import { getClientBillingPlan, countFirmPaidClients } from '@/lib/enterprise/client-billing';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';

/** $95/mo private-label subscription the firm pays to white-label the software. */
export const PRIVATE_LABEL_FEATURE_KEY = 'private_label_95_mo';

/**
 * The end-of-onboarding billing step for a firm. Returns a Stripe Checkout URL,
 * or null when there's nothing to bill (client-pays, no private label).
 *  - Private label enabled → subscription checkout for $95/mo. This both starts
 *    the PL subscription AND saves the card on the firm's customer, so per-client
 *    firm-pays charges work afterward.
 *  - Firm-pays (without private label) → setup-mode checkout to put a card on file.
 */
export async function createEnterpriseOnboardingBillingSession(enterpriseId: string): Promise<string | null> {
  const [org] = await db
    .select({ pl: organizations.privateLabelEnabled, mode: organizations.clientBillingMode })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);

  if (org?.pl) {
    const customerId = await getOrCreateStripeCustomer(enterpriseId);
    const priceId = await priceIdForFeatureKey(PRIVATE_LABEL_FEATURE_KEY);
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: enterpriseId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl()}/enterprise/onboarding?billing=saved`,
      cancel_url: `${appUrl()}/enterprise/onboarding?billing=canceled`,
      subscription_data: { metadata: { organization_id: enterpriseId, feature_key: PRIVATE_LABEL_FEATURE_KEY } },
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return session.url;
  }

  // No private label, but the firm pays for clients (firm_pays, or a "varies"
  // firm with firm-paid clients) → collect a card now. After it lands, the
  // webhook's ensureFirmPaidSubscriptions creates the per-client $69 subs.
  if (org?.mode === 'firm_pays' || (await countFirmPaidClients(enterpriseId)) > 0) {
    return createFirmBillingSetupSession(enterpriseId, '/enterprise/onboarding');
  }

  return null;
}

// Products that should never appear as optional_items in the base Subscribe
// checkout. base_seat is the (legacy) required line item; demo_full is the
// synthetic trial sub that's never sold; the accounting tier products (standard
// + reduced) are PLANS, not add-ons — and the chosen tier is the line item, so
// including it here would make Stripe reject "same Price in line_items and
// optional_items". Add-ons (e.g. qbo_mirroring) + year unlocks still surface.
const HIDDEN_OPTIONAL_FEATURE_KEYS = new Set<string>([
  'base_seat',
  'demo_full',
  'acc_pro_69_client_pay', // legacy $69 client-discount plan (a line item, not an add-on)
  ...ACCOUNTING_TIER_KEYS.flatMap((k) => [
    ACCOUNTING_TIERS[k].billingFeatureKey,
    ACCOUNTING_TIERS[k].reducedBillingFeatureKey,
  ]),
]);

/**
 * One-time period-unlock checkout. Resolves the year being purchased:
 *   - prior_year products carry period_year on the catalog row.
 *   - current_year_unlock is always for the current calendar year.
 * The resolved year + product id ride along on the Checkout Session's
 * metadata so the webhook can write the entitlement row keyed correctly.
 *
 * Throws on misconfigured products (missing Stripe Price ID, missing
 * period_year on a prior_year SKU) since both are super-admin errors that
 * should surface loudly during testing rather than silently fail.
 */
export async function createOneTimeCheckoutSession(orgId: string, billingProductId: string): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);

  const [product] = await db
    .select()
    .from(billingProducts)
    .where(eq(billingProducts.id, billingProductId))
    .limit(1);
  if (!product) throw new Error('Product not found');
  if (!product.stripePriceId) throw new Error(`Product "${product.name}" is not linked to Stripe yet`);
  if (product.kind !== 'one_time') throw new Error('Only one-time products use this flow');
  if (product.featureKey !== 'current_year_unlock' && product.featureKey !== 'prior_year') {
    throw new Error(`Product feature key ${product.featureKey} cannot be purchased as a year unlock`);
  }

  let periodYear: number;
  if (product.featureKey === 'prior_year') {
    if (product.periodYear == null) throw new Error(`Prior-year product "${product.name}" has no period_year set`);
    periodYear = product.periodYear;
  } else {
    periodYear = new Date().getUTCFullYear();
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: product.stripePriceId, quantity: 1 }],
    success_url: `${appUrl()}/billing?unlock=success&year=${periodYear}`,
    cancel_url: `${appUrl()}/billing?unlock=cancel`,
    payment_intent_data: {
      metadata: {
        organization_id: orgId,
        billing_product_id: product.id,
        period_year: String(periodYear),
        feature_key: product.featureKey,
      },
    },
    metadata: {
      organization_id: orgId,
      billing_product_id: product.id,
      period_year: String(periodYear),
      feature_key: product.featureKey,
    },
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/**
 * Collect/save a payment method for the FIRM (enterprise) so it can be charged
 * for the clients it covers (firm-pays). Stripe Checkout in 'setup' mode — the
 * card is captured on Stripe's pages and vaulted on the firm's customer; we
 * never see or store card data. The webhook (mode='setup') sets it as the
 * customer's default payment method.
 */
export async function createFirmBillingSetupSession(
  enterpriseId: string,
  returnPath = '/enterprise/settings',
): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(enterpriseId);
  const session = await stripe().checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    success_url: `${appUrl()}${returnPath}?firm_billing=saved`,
    cancel_url: `${appUrl()}${returnPath}?firm_billing=canceled`,
    metadata: { enterprise_id: enterpriseId, setup: 'firm_billing' },
  });
  if (!session.url) throw new Error('Stripe did not return a setup URL');
  return session.url;
}

/**
 * Resolve the app's public URL for Stripe success/cancel redirects. Falls
 * back to localhost:3000 if NEXT_PUBLIC_APP_URL isn't set so local dev
 * keeps working without extra config.
 */
function appUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}

/**
 * Test-mode price override. billing_products holds LIVE Stripe price ids; for a
 * local test-mode pass set STRIPE_TEST_PRICE_OVERRIDES to a JSON map of
 * featureKey → test price id so checkout uses test prices without editing the
 * (prod) catalog. Unset in production → no effect.
 */
function testPriceOverride(featureKey: string): string | null {
  const raw = process.env.STRIPE_TEST_PRICE_OVERRIDES;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return map[featureKey] ?? null;
  } catch {
    return null;
  }
}

/** Resolve the active Stripe Price ID for a product by feature_key. */
export async function priceIdForFeatureKey(featureKey: string): Promise<string> {
  const override = testPriceOverride(featureKey);
  if (override) return override;
  const [row] = await db
    .select({ stripePriceId: billingProducts.stripePriceId, name: billingProducts.name })
    .from(billingProducts)
    .where(and(eq(billingProducts.featureKey, featureKey), eq(billingProducts.active, true)))
    .limit(1);
  if (!row) throw new Error(`No active "${featureKey}" product configured. Set one up in /super-admin/products.`);
  if (!row.stripePriceId) throw new Error(`Product "${row.name}" is not linked to Stripe yet. Click "Create in Stripe" on its edit page.`);
  return row.stripePriceId;
}

/**
 * The Stripe Price the CLIENT org should be charged for its base subscription.
 * Routes to the firm's discounted $69 product when the firm chose to discount;
 * otherwise the standard $89 base seat. (Firm-paid clients don't reach here —
 * the billing page hides checkout for them.)
 */
async function basePriceIdForOrg(orgId: string): Promise<string> {
  const plan = await getClientBillingPlan(orgId);
  return priceIdForFeatureKey(plan.clientPriceFeatureKey);
}

/**
 * Create a Stripe Checkout Session for the org to start the base $89/mo
 * subscription. Returns the URL the caller should redirect the user to.
 *
 * client_reference_id = organizationId so the webhook can attribute the
 * resulting subscription to the right org without having to dereference
 * the customer.
 */
export async function createSubscriptionCheckoutSession(orgId: string): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);
  const priceId = await basePriceIdForOrg(orgId);
  const optionalItems = await listOptionalCheckoutItems();

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    ...(optionalItems.length > 0 ? { optional_items: optionalItems } : {}),
    success_url: `${appUrl()}/billing?checkout=success`,
    cancel_url: `${appUrl()}/billing?checkout=cancel`,
    subscription_data: {
      metadata: { organization_id: orgId },
    },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/**
 * Subscribe checkout for a brand-new business org that the user just
 * created via the pay-first Add-business flow. Same $89/mo product as
 * createSubscriptionCheckoutSession, but the redirects land in the
 * activate/canceled pages under /businesses/new instead of /billing,
 * because the next step is the onboarding flow — not billing management.
 *
 * The new org row already exists by the time this is called; the
 * orgId rides along on subscription_data.metadata so the existing
 * handleSubscriptionUpsert webhook attributes the resulting subscription
 * correctly without product-specific code.
 */
export async function createNewBusinessCheckoutSession(orgId: string): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);
  const priceId = await basePriceIdForOrg(orgId);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    // {CHECKOUT_SESSION_ID} is a Stripe-side placeholder that lets the
    // activate route reconcile the subscription inline rather than racing
    // the customer.subscription.created webhook.
    success_url: `${appUrl()}/businesses/new/activate?org=${encodeURIComponent(orgId)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl()}/businesses/new/canceled?org=${encodeURIComponent(orgId)}`,
    subscription_data: {
      metadata: { organization_id: orgId },
    },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/**
 * Self-serve signup checkout: collects a card and starts a 7-DAY FREE TRIAL (no
 * charge for 7 days, then auto-converts to the org's plan price). The resulting
 * Stripe subscription is 'trialing' — which the per-company access backbone
 * (lib/billing/access.ts) already treats as covered — so the new user has full
 * access during the trial. Card is required (payment_method_collection:'always').
 * The webhook attributes the sub via subscription_data.metadata.organization_id.
 */
export async function createTrialSignupCheckoutSession(orgId: string): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);
  const priceId = await basePriceIdForOrg(orgId);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: 'always',
    success_url: `${appUrl()}/dashboard?welcome=1`,
    cancel_url: `${appUrl()}/dashboard?billing=needed`,
    subscription_data: {
      metadata: { organization_id: orgId },
      trial_period_days: 7,
    },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/**
 * Every active Stripe-linked product (other than base_seat and demo_full)
 * surfaced as togglable items on the Stripe Checkout page. Includes
 * recurring add-ons (e.g. qbo_mirroring) and one-time year unlocks —
 * Stripe Checkout in subscription mode allows mixing both.
 *
 * Recurring add-ons flow through the existing customer.subscription.*
 * webhooks so handleSubscriptionUpsert handles them without product-
 * specific code. Year unlocks bundled this way still need a webhook
 * change to grant organization_entitlements; until that lands, they
 * appear on the Stripe page but the entitlement is not granted on
 * purchase via this path. Buying year unlocks via the standalone
 * /billing buttons (which use createOneTimeCheckoutSession + the existing
 * mode='payment' webhook flow) does grant entitlements correctly.
 */
async function listOptionalCheckoutItems(): Promise<{ price: string; quantity: number }[]> {
  // In test-mode (override active) the catalog's live price ids are invalid, so
  // skip add-ons — the billing test only needs the base + firm/PL prices.
  if (process.env.STRIPE_TEST_PRICE_OVERRIDES) return [];
  const rows = await db
    .select({
      stripePriceId: billingProducts.stripePriceId,
      featureKey: billingProducts.featureKey,
    })
    .from(billingProducts)
    .where(and(
      eq(billingProducts.active, true),
      isNotNull(billingProducts.stripePriceId),
    ));
  return rows
    .filter((r): r is { stripePriceId: string; featureKey: string } =>
      !!r.stripePriceId &&
      !HIDDEN_OPTIONAL_FEATURE_KEYS.has(r.featureKey) &&
      // Firm/partner products are never client checkout add-ons. They also
      // include yearly prices (enterprise_seat_cp1), which Stripe rejects when
      // mixed into a monthly subscription's optional_items. Genuine add-ons
      // (e.g. qbo_mirroring) are monthly client products and still pass.
      !r.featureKey.startsWith('enterprise_seat_') &&
      !r.featureKey.startsWith('private_label_'))
    .map((r) => ({ price: r.stripePriceId, quantity: 1 }));
}

/**
 * Start a subscription Checkout for a specific add-on product (e.g.
 * qbo_mirroring). Validates the product is subscription-kind, active, and
 * Stripe-linked before opening the session. Mirrors createSubscriptionCheckoutSession
 * but driven by the product id instead of the catalog's "base_seat" lookup.
 *
 * Webhook attribution rides on client_reference_id + subscription_data.metadata
 * the same way as the base subscription, so the existing
 * handleSubscriptionUpsert handler picks up the resulting subscription
 * without any product-specific code.
 */
export async function createAddOnSubscriptionCheckoutSession(orgId: string, billingProductId: string): Promise<string> {
  const customerId = await getOrCreateStripeCustomer(orgId);

  const [product] = await db
    .select()
    .from(billingProducts)
    .where(eq(billingProducts.id, billingProductId))
    .limit(1);
  if (!product) throw new Error('Product not found');
  if (!product.active) throw new Error(`Product "${product.name}" is inactive`);
  if (product.kind !== 'subscription') {
    throw new Error(`Product "${product.name}" is not a subscription (kind=${product.kind})`);
  }
  if (!product.stripePriceId) throw new Error(`Product "${product.name}" is not linked to Stripe yet`);

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: orgId,
    line_items: [{ price: product.stripePriceId, quantity: 1 }],
    success_url: `${appUrl()}/billing?checkout=success`,
    cancel_url: `${appUrl()}/billing?checkout=cancel`,
    subscription_data: {
      metadata: {
        organization_id: orgId,
        billing_product_id: product.id,
        feature_key: product.featureKey,
      },
    },
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}
